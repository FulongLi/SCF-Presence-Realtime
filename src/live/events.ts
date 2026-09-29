/**
 * The slice of the GPT-Live data-channel protocol SCF needs, normalized. Event names follow the current
 * GPT-Live reference (developers.openai.com/api/reference/resources/live); none of them are Realtime
 * events. Live has no speech-started/stopped, audio-done or barge-in events: the assistant's audio
 * (on the WebRTC media track) is the only speaking signal, and transcript deltas show who is talking.
 *
 * Responses delegation arrives as `response.event` envelopes wrapping ordinary Responses streaming
 * events; the nested ones SCF uses are normalized to `backend.*` events here.
 */
import type { FunctionCallItem } from "../realtime/events";

export type { FunctionCallItem };

export interface BackendUsage { inputTokens: number; outputTokens: number; totalTokens: number; cachedTokens: number }
export type BackendStatus = "completed" | "failed" | "incomplete" | "cancelled";
export type LiveCloseReason = "close_requested" | "expired" | "content" | "remote_hangup" | "connection_lost" | "unknown";

export type LiveEvent =
  | { type: "session.started"; sessionId?: string; model?: string; voice?: string; expiresAt?: number }
  | { type: "session.closed"; reason: LiveCloseReason; seconds?: number }
  | { type: "usage"; seconds: number; contextRatio?: number }
  | { type: "delegation.created"; delegationId: string; target: "responses" | "client"; responseId?: string; offsetMs?: number }
  | { type: "transcript.user"; text: string; startMs?: number; endMs?: number }
  | { type: "transcript.assistant"; text: string; startMs?: number; endMs?: number }
  /** Nested `response.created`: a backend response (first, or a continuation) started. */
  | { type: "backend.response.started"; delegationId?: string; responseId: string }
  /** Nested `response.output_item.done` with a finished function_call item. */
  | { type: "backend.function_call"; delegationId?: string; call: FunctionCallItem }
  /** Nested terminal lifecycle event (`response.completed`, `.failed`, `.incomplete`, `.cancelled`). */
  | { type: "backend.response.finished"; delegationId?: string; responseId?: string; status: BackendStatus; usage?: BackendUsage }
  | { type: "backend.other"; delegationId?: string; name: string }
  /** Acknowledgements (`session.updated`, `session.*.appended`, mute/unmute). */
  | { type: "ack"; name: string; clientEventId?: string }
  | { type: "error"; code?: string; message: string; errorType?: string; clientEventId?: string }
  | { type: "ignored"; name: string };

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const str = (value: unknown) => typeof value === "string" ? value : undefined;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const CLOSE_REASONS = new Set(["close_requested", "expired", "content", "remote_hangup", "connection_lost"]);
const TERMINAL: Record<string, BackendStatus> = {
  "response.completed": "completed", "response.failed": "failed",
  "response.incomplete": "incomplete", "response.cancelled": "cancelled",
};
const ACKS = new Set([
  "session.updated", "session.instructions.appended", "session.thinking.appended", "session.commentary.appended",
  "session.input_audio.muted", "session.input_audio.unmuted",
]);

function backendUsage(value: unknown): BackendUsage | undefined {
  const u = obj(value);
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0, totalTokens: num(u.total_tokens) ?? 0,
    cachedTokens: num(obj(u.input_tokens_details)?.cached_tokens) ?? 0,
  };
}

/** A finished Responses function-call item. Its `call_id`, `name` and `arguments` identify the call. */
function functionCall(value: unknown): FunctionCallItem | null {
  const item = obj(value);
  const callId = str(item?.call_id), name = str(item?.name);
  if (item?.type !== "function_call" || !callId || !name) return null;
  return { callId, itemId: str(item.id), name, arguments: str(item.arguments) ?? "" };
}

/** Normalizes the Responses event nested in a `response.event` envelope. */
function nested(raw: Json, delegationId: string | undefined): LiveEvent {
  const event = obj(raw.event);
  const type = str(event?.type);
  if (!event || !type) return { type: "ignored", name: "response.event" };
  const response = obj(event.response);
  if (type === "response.created") {
    const responseId = str(response?.id);
    return responseId ? { type: "backend.response.started", delegationId, responseId } : { type: "backend.other", delegationId, name: type };
  }
  if (type === "response.output_item.done") {
    const call = functionCall(event.item);
    return call ? { type: "backend.function_call", delegationId, call } : { type: "backend.other", delegationId, name: type };
  }
  if (type in TERMINAL) {
    return { type: "backend.response.finished", delegationId, responseId: str(response?.id), status: TERMINAL[type], usage: backendUsage(response?.usage) };
  }
  return { type: "backend.other", delegationId, name: type };
}

/** Parses one data-channel message. Malformed input never throws. */
export function parseLiveEvent(data: unknown): LiveEvent {
  let raw: Json | undefined;
  try { raw = obj(typeof data === "string" ? JSON.parse(data) : data); } catch { raw = undefined; }
  const type = str(raw?.type);
  if (!raw || !type) return { type: "ignored", name: "malformed" };
  switch (type) {
    case "session.started": {
      const session = obj(raw.session);
      return {
        type: "session.started", sessionId: str(session?.id), model: str(session?.model),
        voice: str(obj(obj(session?.audio)?.output)?.voice), expiresAt: num(session?.expires_at),
      };
    }
    case "session.closed": {
      const reason = str(raw.reason);
      return { type: "session.closed", reason: reason && CLOSE_REASONS.has(reason) ? reason as LiveCloseReason : "unknown", seconds: num(obj(raw.usage)?.seconds) };
    }
    case "session.usage.updated":
      return { type: "usage", seconds: num(obj(raw.usage)?.seconds) ?? 0, contextRatio: num(obj(raw.context_window)?.usage_ratio) };
    case "session.delegation.created": {
      const delegation = obj(raw.delegation);
      const id = str(delegation?.id), target = str(delegation?.target);
      if (!id || (target !== "responses" && target !== "client")) return { type: "ignored", name: type };
      return { type: "delegation.created", delegationId: id, target, responseId: str(delegation?.response_id), offsetMs: num(raw.offset_ms) };
    }
    case "session.input_transcript.delta":
      return { type: "transcript.user", text: str(raw.delta) ?? "", startMs: num(raw.start_ms), endMs: num(raw.end_ms) };
    case "session.output_transcript.delta":
      return { type: "transcript.assistant", text: str(raw.delta) ?? "", startMs: num(raw.start_ms), endMs: num(raw.end_ms) };
    case "response.event":
      return nested(raw, str(raw.delegation_id) ?? undefined);
    case "error": {
      const error = obj(raw.error);
      return {
        type: "error", code: str(error?.code), message: str(error?.message) ?? "Live error",
        errorType: str(error?.type), clientEventId: str(error?.client_event_id),
      };
    }
    default:
      return ACKS.has(type) ? { type: "ack", name: type, clientEventId: str(raw.client_event_id) } : { type: "ignored", name: type };
  }
}

/**
 * Client events SCF sends on a Live data channel. The session is started by the server's HTTP request,
 * so there is no `session.start` here; the server also restricts the frontend to exactly these types.
 */
export type LiveClientEvent =
  | { type: "response.item.create"; event_id: string; item: { type: "function_call_output"; call_id: string; output: string } }
  | { type: "response.create"; event_id: string }
  /** Content for GPT-Live to say in its own words (Aion's first greeting); `null`: general session context. */
  | { type: "session.commentary.append"; event_id: string; content: string; delegation_id: null }
  | { type: "session.close"; event_id: string };

/**
 * What the browser may send. `session.commentary.append` lets the page ask the voice to say a short
 * line (the first greeting); it cannot change instructions, tools or the session.
 */
export const LIVE_FRONTEND_CLIENT_EVENTS: readonly LiveClientEvent["type"][] = ["response.item.create", "response.create", "session.commentary.append", "session.close"];

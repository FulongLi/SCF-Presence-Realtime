/**
 * The small slice of the GA Realtime server event stream SCF needs, normalized.
 * OpenAI owns the conversation; SCF only reads session, turn, response, audio-buffer, tool and error
 * events. Everything else is passed through as "ignored" (visible in debug only).
 */
export interface ResponseUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  inputTextTokens: number;
  cachedTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
}

export interface FunctionCallItem { callId: string; itemId?: string; name: string; arguments: string }
export type ResponseStatus = "completed" | "cancelled" | "incomplete" | "failed" | "in_progress";

export type RealtimeEvent =
  | { type: "session.ready"; sessionId?: string; model?: string }
  | { type: "user.speech_started"; itemId?: string }
  | { type: "user.speech_stopped"; itemId?: string }
  | { type: "response.started"; responseId: string }
  | { type: "response.output"; responseId: string; kind: "message" | "function_call" | "other" }
  | { type: "response.finished"; responseId: string; status: ResponseStatus; reason?: string;
      spoke: boolean; functionCalls: FunctionCallItem[]; usage?: ResponseUsage; errorMessage?: string }
  | { type: "audio.started"; responseId?: string }
  | { type: "audio.stopped"; responseId?: string }
  | { type: "audio.cleared"; responseId?: string }
  | { type: "tool.arguments"; responseId: string; callId: string; itemId?: string; delta: string }
  | { type: "tool.call"; responseId: string; call: FunctionCallItem }
  | { type: "transcript.user"; itemId?: string; text: string }
  | { type: "transcript.assistant"; responseId?: string; text: string }
  | { type: "rate_limits"; limits: { name: string; remaining: number; limit: number }[] }
  | { type: "error"; code?: string; message: string; errorType?: string }
  | { type: "ignored"; name: string };

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const str = (value: unknown) => typeof value === "string" ? value : undefined;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const arr = (value: unknown) => Array.isArray(value) ? value : [];

function usage(value: unknown): ResponseUsage | undefined {
  const u = obj(value);
  if (!u) return undefined;
  const input = obj(u.input_token_details) ?? {}, output = obj(u.output_token_details) ?? {};
  return {
    totalTokens: num(u.total_tokens), inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens),
    inputAudioTokens: num(input.audio_tokens), inputTextTokens: num(input.text_tokens), cachedTokens: num(input.cached_tokens),
    outputAudioTokens: num(output.audio_tokens), outputTextTokens: num(output.text_tokens),
  };
}

export function functionCallItem(value: unknown): FunctionCallItem | null {
  const item = obj(value);
  const callId = str(item?.call_id), name = str(item?.name);
  if (item?.type !== "function_call" || !callId || !name) return null;
  return { callId, itemId: str(item.id), name, arguments: str(item.arguments) ?? "" };
}

/** Parses one data-channel message. Malformed input never throws. */
export function parseServerEvent(data: unknown): RealtimeEvent {
  let raw: Json | undefined;
  try { raw = obj(typeof data === "string" ? JSON.parse(data) : data); } catch { raw = undefined; }
  const type = str(raw?.type);
  if (!raw || !type) return { type: "ignored", name: "malformed" };
  switch (type) {
    case "session.created": {
      const session = obj(raw.session);
      return { type: "session.ready", sessionId: str(session?.id), model: str(session?.model) };
    }
    case "input_audio_buffer.speech_started":
      return { type: "user.speech_started", itemId: str(raw.item_id) };
    case "input_audio_buffer.speech_stopped":
      return { type: "user.speech_stopped", itemId: str(raw.item_id) };
    case "response.created": {
      const id = str(obj(raw.response)?.id);
      return id ? { type: "response.started", responseId: id } : { type: "ignored", name: type };
    }
    case "response.output_item.added": {
      const item = obj(raw.item), responseId = str(raw.response_id);
      if (!responseId) return { type: "ignored", name: type };
      const kind = item?.type === "message" ? "message" : item?.type === "function_call" ? "function_call" : "other";
      return { type: "response.output", responseId, kind };
    }
    case "response.done": {
      const response = obj(raw.response);
      const id = str(response?.id);
      if (!response || !id) return { type: "ignored", name: type };
      const output = arr(response.output);
      const details = obj(response.status_details);
      const status = str(response.status) as ResponseStatus | undefined;
      return {
        type: "response.finished", responseId: id, status: status ?? "completed",
        reason: str(details?.reason),
        errorMessage: str(obj(details?.error)?.message),
        spoke: output.some(item => obj(item)?.type === "message"),
        functionCalls: output.map(functionCallItem).filter((item): item is FunctionCallItem => item !== null),
        usage: usage(response.usage),
      };
    }
    case "output_audio_buffer.started":
      return { type: "audio.started", responseId: str(raw.response_id) };
    case "output_audio_buffer.stopped":
      return { type: "audio.stopped", responseId: str(raw.response_id) };
    case "output_audio_buffer.cleared":
      return { type: "audio.cleared", responseId: str(raw.response_id) };
    case "response.function_call_arguments.delta": {
      const responseId = str(raw.response_id), callId = str(raw.call_id);
      if (!responseId || !callId) return { type: "ignored", name: type };
      return { type: "tool.arguments", responseId, callId, itemId: str(raw.item_id), delta: str(raw.delta) ?? "" };
    }
    case "response.function_call_arguments.done": {
      const responseId = str(raw.response_id), callId = str(raw.call_id), name = str(raw.name);
      if (!responseId || !callId || !name) return { type: "ignored", name: type };
      return { type: "tool.call", responseId, call: { callId, itemId: str(raw.item_id), name, arguments: str(raw.arguments) ?? "" } };
    }
    case "conversation.item.input_audio_transcription.completed":
      return { type: "transcript.user", itemId: str(raw.item_id), text: str(raw.transcript) ?? "" };
    case "response.output_audio_transcript.done":
      return { type: "transcript.assistant", responseId: str(raw.response_id), text: str(raw.transcript) ?? "" };
    case "rate_limits.updated":
      return {
        type: "rate_limits",
        limits: arr(raw.rate_limits).map(obj).filter((item): item is Json => Boolean(item))
          .map(item => ({ name: str(item.name) ?? "?", remaining: num(item.remaining), limit: num(item.limit) })),
      };
    case "error": {
      const error = obj(raw.error);
      return { type: "error", code: str(error?.code), message: str(error?.message) ?? "Realtime error", errorType: str(error?.type) };
    }
    default:
      return { type: "ignored", name: type };
  }
}

/** GA client events SCF sends over the data channel. */
export type ClientEvent =
  | { type: "conversation.item.create"; item: { type: "function_call_output"; call_id: string; output: string } }
  /** `response.instructions` makes this one response say a given line (Aion's first greeting). */
  | { type: "response.create"; response?: { instructions: string } }
  | { type: "response.cancel" }
  | { type: "output_audio_buffer.clear" };

import type { ConversationHints } from "../presence/PresenceEngine";
import type { ConnectionState } from "../voice/client";
import type { BackendStatus, BackendUsage, LiveCloseReason, LiveEvent } from "./events";

/** The session lifecycle as one label: connection states, and while connected, what the conversation is doing. */
export type LivePhase = ConnectionState | "listening" | "thinking" | "speaking";

/**
 * What SCF tracks about a GPT-Live conversation — only what the body and the debug panel need.
 * GPT-Live is full duplex and has no turn or audio-done events, so this state is built from transcript
 * activity and delegation lifecycle; the assistant's actual audio decides speaking in the PresenceEngine.
 */
export interface LivePresenceState {
  connection: ConnectionState;
  error: string | null;
  connectedAt: number | null;
  sessionId: string | null;
  model: string | null;
  backendModel: string | null;
  voice: string | null;
  /** When the last user transcript fragment arrived (the backend hears the user). */
  userHeardAt: number | null;
  /** When the last assistant transcript fragment arrived. */
  assistantHeardAt: number | null;
  /** Delegations still running, and when delegation activity last happened (bounds a lost terminal event). */
  delegationsActive: number;
  delegationAt: number | null;
  toolsActive: number;
  /** Cumulative Live voice seconds (session.usage.updated; not summed). */
  usageSeconds: number;
  contextRatio: number | null;
  /** Delegated Responses token usage, summed from nested terminal events. */
  backendUsage: BackendUsage;
  closeReason: LiveCloseReason | null;
}

export type LiveStateEvent =
  | LiveEvent
  | { type: "connection"; state: ConnectionState; error?: string }
  | { type: "session.answered"; sessionId?: string; model: string; backendModel: string; voice: string }
  | { type: "delegation.started" }
  | { type: "delegation.finished"; status: BackendStatus | "abandoned" }
  | { type: "tool.started" }
  | { type: "tool.finished" };

export const liveTiming = {
  /** Transcript fragments arrive in bursts; the user counts as talking this long after the last one. */
  userHoldMs: 900,
  /** After the user stops, a reply is expected for this long (the body may think) unless the assistant speaks. */
  replyWindowMs: 2500,
  /** A delegation with no activity for this long no longer keeps the body thinking (lost terminal event). */
  delegationStaleMs: 30_000,
  /** Assistant transcript this recent means the assistant is still mid-reply (idle timeout must wait). */
  assistantBusyMs: 3000,
};

const emptyUsage = (): BackendUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 });

export function initialLiveState(): LivePresenceState {
  return {
    connection: "disconnected", error: null, connectedAt: null, sessionId: null, model: null, backendModel: null, voice: null,
    userHeardAt: null, assistantHeardAt: null, delegationsActive: 0, delegationAt: null, toolsActive: 0,
    usageSeconds: 0, contextRatio: null, backendUsage: emptyUsage(), closeReason: null,
  };
}

/** A dropped or ended session must not leave the body listening, thinking or speaking. */
const quiet = (state: LivePresenceState): LivePresenceState => ({
  ...state, userHeardAt: null, assistantHeardAt: null, delegationsActive: 0, delegationAt: null, toolsActive: 0,
});

export function reduceLive(state: LivePresenceState, event: LiveStateEvent, now: number): LivePresenceState {
  switch (event.type) {
    case "connection": {
      const next = quiet({ ...state, connection: event.state, error: event.error ?? (event.state === "error" ? state.error : null) });
      if (event.state === "connected") return { ...next, connectedAt: now };
      if (event.state === "connecting") return { ...next, sessionId: null, closeReason: null, usageSeconds: 0, contextRatio: null, backendUsage: emptyUsage() };
      return next;
    }
    case "session.answered":
      return { ...state, sessionId: event.sessionId ?? state.sessionId, model: event.model, backendModel: event.backendModel, voice: event.voice };
    case "session.started":
      return { ...state, sessionId: event.sessionId ?? state.sessionId, model: event.model ?? state.model, voice: event.voice ?? state.voice };
    case "session.closed":
      return { ...quiet(state), closeReason: event.reason, usageSeconds: event.seconds ?? state.usageSeconds };
    case "usage":
      return { ...state, usageSeconds: event.seconds, contextRatio: event.contextRatio ?? state.contextRatio };
    case "transcript.user":
      return event.text.trim() ? { ...state, userHeardAt: now } : state;
    case "transcript.assistant":
      return event.text.trim() ? { ...state, assistantHeardAt: now } : state;
    case "delegation.started":
      return { ...state, delegationsActive: state.delegationsActive + 1, delegationAt: now };
    case "delegation.finished":
      return { ...state, delegationsActive: Math.max(0, state.delegationsActive - 1), delegationAt: now };
    case "backend.response.started":
    case "backend.function_call":
      return { ...state, delegationAt: now };
    case "backend.response.finished": {
      const u = state.backendUsage, add = event.usage;
      return {
        ...state, delegationAt: now,
        backendUsage: add ? {
          inputTokens: u.inputTokens + add.inputTokens, outputTokens: u.outputTokens + add.outputTokens,
          totalTokens: u.totalTokens + add.totalTokens, cachedTokens: u.cachedTokens + add.cachedTokens,
        } : u,
      };
    }
    case "tool.started":
      return { ...state, toolsActive: state.toolsActive + 1 };
    case "tool.finished":
      return { ...state, toolsActive: Math.max(0, state.toolsActive - 1) };
    case "error":
      return { ...state, error: event.code ?? event.errorType ?? "live-error" };
    default:
      return state;
  }
}

const recent = (at: number | null, now: number, ms: number) => at !== null && now - at < ms;

/**
 * Hints for the body. `fullDuplex` tells the PresenceEngine that user speech during audible assistant
 * audio is overlap (backchannel, aside), not a hard barge-in; GPT-Live itself decides whether to yield,
 * and the engine sees that as the assistant's audio stopping.
 */
export function liveHints(state: LivePresenceState, now: number): ConversationHints {
  if (state.connection !== "connected") return { live: false, userSpeaking: false, awaitingResponse: false, toolActive: false, fullDuplex: true };
  const t = liveTiming;
  const userSpeaking = recent(state.userHeardAt, now, t.userHoldMs);
  const delegating = state.delegationsActive > 0 && recent(state.delegationAt, now, t.delegationStaleMs);
  const replyExpected = !userSpeaking && recent(state.userHeardAt, now, t.userHoldMs + t.replyWindowMs)
    && (state.assistantHeardAt === null || state.assistantHeardAt < state.userHeardAt!);
  return { live: true, userSpeaking, awaitingResponse: delegating || replyExpected, toolActive: state.toolsActive > 0, fullDuplex: true };
}

export function liveBusy(state: LivePresenceState, now: number): boolean {
  const h = liveHints(state, now);
  return h.userSpeaking || h.awaitingResponse || h.toolActive || recent(state.assistantHeardAt, now, liveTiming.assistantBusyMs);
}

export function livePhase(state: LivePresenceState, now: number): LivePhase {
  if (state.connection !== "connected") return state.connection;
  const h = liveHints(state, now);
  if (h.userSpeaking) return "listening";
  if (recent(state.assistantHeardAt, now, liveTiming.userHoldMs)) return "speaking";
  return h.awaitingResponse || h.toolActive ? "thinking" : "connected";
}

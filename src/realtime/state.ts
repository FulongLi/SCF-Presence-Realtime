import type { ConversationHints } from "../presence/PresenceEngine";
import type { RealtimeEvent, ResponseUsage } from "./events";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error" | "ended";
/** The session lifecycle as one label: connection states, and while connected, the turn phase. */
export type SessionPhase = ConnectionState | "listening" | "thinking" | "speaking";

/**
 * What SCF tracks about the Realtime conversation. OpenAI keeps the conversation itself; this is only
 * turn/response/audio timing for the body, plus counters for development diagnostics.
 */
export interface RealtimePresenceState {
  connection: ConnectionState;
  error: string | null;
  connectedAt: number | null;
  sessionId: string | null;
  model: string | null;
  userSpeaking: boolean;
  /** When the user's turn ended (or a tool-only response finished) and a response is expected. */
  awaitingSince: number | null;
  responseActive: boolean;
  activeResponseId: string | null;
  /** WebRTC output buffer is streaming assistant audio (output_audio_buffer.started → stopped/cleared). */
  audioActive: boolean;
  toolsActive: number;
  responses: number;
  interruptions: number;
  /** The response whose barge-in was already counted (cleared audio and its cancelled response.done are one event). */
  interruptedResponseId: string | null;
  usage: ResponseUsage;
}

export type StateEvent =
  | RealtimeEvent
  | { type: "connection"; state: ConnectionState; error?: string }
  | { type: "tool.started" }
  | { type: "tool.finished" };

const emptyUsage = (): ResponseUsage => ({
  totalTokens: 0, inputTokens: 0, outputTokens: 0, inputAudioTokens: 0, inputTextTokens: 0,
  cachedTokens: 0, outputAudioTokens: 0, outputTextTokens: 0,
});

export function initialState(): RealtimePresenceState {
  return {
    connection: "disconnected", error: null, connectedAt: null, sessionId: null, model: null,
    userSpeaking: false, awaitingSince: null, responseActive: false, activeResponseId: null,
    audioActive: false, toolsActive: 0, responses: 0, interruptions: 0, interruptedResponseId: null, usage: emptyUsage(),
  };
}

/** A dropped or ended session must not leave the body speaking or thinking. */
const quiet = (state: RealtimePresenceState): RealtimePresenceState => ({
  ...state, userSpeaking: false, awaitingSince: null, responseActive: false, activeResponseId: null,
  audioActive: false, toolsActive: 0,
});

/** How long an expected response may take to begin before the body stops thinking. */
export const AWAIT_RESPONSE_MS = 6000;

export function reduce(state: RealtimePresenceState, event: StateEvent, now: number): RealtimePresenceState {
  switch (event.type) {
    case "connection": {
      const next = quiet({ ...state, connection: event.state, error: event.error ?? (event.state === "error" ? state.error : null) });
      if (event.state === "connected") return { ...next, connectedAt: now };
      if (event.state === "connecting") return { ...next, sessionId: null };
      return next;
    }
    case "session.ready":
      return { ...state, sessionId: event.sessionId ?? state.sessionId, model: event.model ?? state.model };
    case "user.speech_started":
      return { ...state, userSpeaking: true, awaitingSince: null };
    case "user.speech_stopped":
      return { ...state, userSpeaking: false, awaitingSince: now };
    case "response.started":
      return { ...state, responseActive: true, activeResponseId: event.responseId, awaitingSince: null, responses: state.responses + 1 };
    case "response.finished": {
      const current = state.activeResponseId === event.responseId || state.activeResponseId === null;
      const u = state.usage, add = event.usage;
      const usage = add ? {
        totalTokens: u.totalTokens + add.totalTokens, inputTokens: u.inputTokens + add.inputTokens,
        outputTokens: u.outputTokens + add.outputTokens, inputAudioTokens: u.inputAudioTokens + add.inputAudioTokens,
        inputTextTokens: u.inputTextTokens + add.inputTextTokens, cachedTokens: u.cachedTokens + add.cachedTokens,
        outputAudioTokens: u.outputAudioTokens + add.outputAudioTokens, outputTextTokens: u.outputTextTokens + add.outputTextTokens,
      } : u;
      // A response cancelled by turn detection is a barge-in, counted once even if its audio was cleared.
      const interrupted = event.status === "cancelled" && event.reason === "turn_detected" && state.interruptedResponseId !== event.responseId;
      // A tool-only response is usually followed by a continuation: keep thinking in between.
      const continuation = event.status === "completed" && !event.spoke && event.functionCalls.length > 0;
      return {
        ...state, usage,
        responseActive: current ? false : state.responseActive,
        activeResponseId: current ? null : state.activeResponseId,
        awaitingSince: continuation && !state.userSpeaking ? now : state.awaitingSince,
        interruptions: state.interruptions + (interrupted ? 1 : 0),
        interruptedResponseId: interrupted ? event.responseId : state.interruptedResponseId,
      };
    }
    case "audio.started":
      return { ...state, audioActive: true };
    case "audio.stopped":
      return { ...state, audioActive: false };
    case "audio.cleared": {
      // Cleared while playing: the user interrupted and the server cut the unplayed audio.
      const responseId = event.responseId ?? state.activeResponseId;
      const counted = !state.audioActive || (responseId !== null && responseId === state.interruptedResponseId);
      return {
        ...state, audioActive: false,
        interruptions: state.interruptions + (counted ? 0 : 1),
        interruptedResponseId: counted ? state.interruptedResponseId : responseId,
      };
    }
    case "tool.started":
      return { ...state, toolsActive: state.toolsActive + 1 };
    case "tool.finished":
      return { ...state, toolsActive: Math.max(0, state.toolsActive - 1) };
    case "error":
      return { ...state, error: event.code ?? event.errorType ?? "realtime-error" };
    default:
      return state;
  }
}

export function presenceHints(state: RealtimePresenceState, now: number): ConversationHints {
  const live = state.connection === "connected";
  if (!live) return { live: false, userSpeaking: false, awaitingResponse: false, toolActive: false };
  const awaiting = state.awaitingSince !== null && now - state.awaitingSince < AWAIT_RESPONSE_MS;
  return {
    live,
    userSpeaking: state.userSpeaking,
    awaitingResponse: (state.responseActive && !state.audioActive) || awaiting,
    toolActive: state.toolsActive > 0,
  };
}

export function sessionPhase(state: RealtimePresenceState, now: number): SessionPhase {
  if (state.connection !== "connected") return state.connection;
  if (state.userSpeaking) return "listening";
  if (state.audioActive) return "speaking";
  const hints = presenceHints(state, now);
  return hints.awaitingResponse || hints.toolActive ? "thinking" : "connected";
}

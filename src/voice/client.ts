import type { ConversationSource } from "../presence/PresenceEngine";
import type { VoiceBackend } from "./backend";

/** The connection lifecycle every voice backend reports. */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error" | "ended";

/** A transcript line kept in memory for ?debug=1 only. */
export interface Transcript { role: "user" | "assistant"; text: string; at: number }

/**
 * What PresenceController needs from a voice backend — deliberately little. Each backend keeps its own
 * protocol, events and state inside its adapter; the controller only connects, disconnects, reads
 * conversation hints for the body and asks whether a conversation is in progress.
 *
 * The adapters report through their own callbacks; PresenceController maps them onto the shared
 * microphone, AssistantAudio and PresenceEngine, so the particle body never knows which backend spoke.
 */
export interface VoiceClient extends ConversationSource {
  readonly backend: VoiceBackend;
  readonly connection: ConnectionState;
  readonly transcripts: readonly Transcript[];
  /** Starts a session with the page's microphone stream. A second call while active is a no-op. */
  connect(microphone: MediaStream): void;
  /** Ends the session on purpose; no reconnect follows. */
  disconnect(final?: "disconnected" | "ended"): void;
  /** A conversation is in progress (user speaking, assistant audible, backend work running). `now` in ms. */
  busy(now: number): boolean;
  /** Asks the voice to say a short line itself (Aion's first greeting). False when it cannot now. */
  speak(line: string): boolean;
}

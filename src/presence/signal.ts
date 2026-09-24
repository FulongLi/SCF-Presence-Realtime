import { SPECTRUM_BANDS } from "../audio/spectrum";

export const PRESENCE_MODES = ["idle", "listening", "thinking", "speaking"] as const;
export type PresenceMode = typeof PRESENCE_MODES[number];

/**
 * The only thing the particle runtime knows about the conversation.
 * Every field is already smoothed and bounded; the renderer never sees the Realtime session,
 * WebRTC, tools or permission state.
 */
export interface PresenceSignal {
  mode: PresenceMode;
  /** Overall internal energy. */
  energy: number;
  /** Inward attention toward the user (listening coherence). */
  focus: number;
  /** Colour temperature of the body. */
  warmth: number;
  /** Internal turbulence and rotation (thinking). */
  thinking: number;
  /** Local microphone loudness while listening. */
  userAmplitude: number;
  /** Assistant audio loudness while speaking. */
  assistantAmplitude: number;
  /** Transient contraction impulse from acoustic emphasis. */
  acousticFocus: number;
  /** Assistant audio spectrum, one value per band. */
  assistantBands: Float32Array;
}

export interface PresenceSignalSource {
  sample(dt: number, now: number): PresenceSignal;
}

export const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export function createSignal(): PresenceSignal {
  return {
    mode: "idle", energy: 0.08, focus: 0, warmth: 0.35, thinking: 0,
    userAmplitude: 0, assistantAmplitude: 0, acousticFocus: 0,
    assistantBands: new Float32Array(SPECTRUM_BANDS),
  };
}

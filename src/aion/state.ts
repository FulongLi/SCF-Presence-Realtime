import type { PresenceMode } from "../presence/signal";

/**
 * Aion's state: what it is doing right now. Separate from identity (who) and body (which form).
 *
 * The state is derived only from real signals, never from guessed emotions:
 *
 *   PresenceEngine mode       idle | listening | thinking | speaking   (microphone VAD, backend turn events,
 *                                                                        the actual assistant audio)
 *   a temporary visual        presenting   (a visual tool is resolving or formed)
 *   the user's turn ending    acknowledging (a small nod: listening → thinking or speaking)
 *   the first greeting        greeting      (a small wave, once per session)
 *   curious                   only when asked for (debug); nothing infers curiosity
 *
 * Timed gestures (greeting, acknowledging, curious) last a fixed time and then hand back to the
 * underlying state. A debug override holds any state. The machine is deterministic: the same inputs at
 * the same times give the same states.
 */
export const AION_STATES = ["idle", "listening", "thinking", "speaking", "greeting", "acknowledging", "curious", "presenting"] as const;
export type AionState = typeof AION_STATES[number];

/** How long each one-shot gesture lasts (seconds). */
export const GESTURE_SECONDS = { greeting: 2.8, acknowledging: 0.9, curious: 2.6 } as const;
export type AionGesture = keyof typeof GESTURE_SECONDS;
export const isGesture = (state: string): state is AionGesture => state in GESTURE_SECONDS;

export const isAionState = (value: unknown): value is AionState =>
  typeof value === "string" && (AION_STATES as readonly string[]).includes(value);
/** Anything that is not a known state is idle. */
export const sanitizeState = (value: unknown): AionState => isAionState(value) ? value : "idle";

export interface StateInputs {
  /** The PresenceEngine's mode this frame. */
  mode: PresenceMode | string;
  /** A temporary visual is resolving, forming or held. */
  presenting: boolean;
}

export class AionStateMachine {
  state: AionState = "idle";
  /** When the current state began (seconds, the caller's clock). */
  since = 0;
  /** Development override; production never sets it. */
  override: AionState | null = null;
  private gesture: { name: AionGesture; until: number } | null = null;
  private pending: AionGesture | null = null;
  private lastMode: string = "idle";

  /** Requests a one-shot gesture; it starts on the next update. */
  trigger(gesture: AionGesture) { if (isGesture(gesture)) this.pending = gesture; }

  /** Forces a state (debug); null returns to the automatic state. Invalid values are ignored as idle. */
  force(state: unknown) { this.override = state === null ? null : sanitizeState(state); }

  update(inputs: StateInputs, now: number): AionState {
    const mode = sanitizeState(inputs.mode);
    const base: AionState = mode === "listening" || mode === "thinking" || mode === "speaking" ? mode : "idle";
    // The user finished and Aion takes it up: one small nod. (Only a real turn end, never a guess.)
    if (this.lastMode === "listening" && (base === "thinking" || base === "speaking") && !this.gesture) this.pending ??= "acknowledging";
    this.lastMode = base;
    if (this.pending) {
      // The greeting outranks a nod; a nod never interrupts a greeting.
      if (!this.gesture || this.pending === "greeting" || this.gesture.name !== "greeting") {
        this.gesture = { name: this.pending, until: now + GESTURE_SECONDS[this.pending] };
      }
      this.pending = null;
    }
    if (this.gesture && now >= this.gesture.until) this.gesture = null;

    let next: AionState;
    if (this.override) next = this.override;
    else if (this.gesture?.name === "greeting") next = "greeting";
    else if (inputs.presenting) next = "presenting";
    else if (this.gesture) next = this.gesture.name;
    else next = base;
    if (next !== this.state) { this.state = next; this.since = now; }
    return this.state;
  }
}

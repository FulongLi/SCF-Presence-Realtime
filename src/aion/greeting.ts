/**
 * The first greeting, once per user session (one page session: reconnects, backend switches and idle
 * pauses do not greet again).
 *
 *   page loaded → microphone ready → voice session connected → visual body ready (or known unavailable)
 *   → a short quiet settle → greet
 *
 * If the user speaks first (or the assistant is already talking), the greeting is suppressed for good:
 * the conversation has started and a scripted line would only interrupt it.
 */
export type GreetingStatus = "waiting" | "settling" | "sent" | "suppressed";

export interface GreetingInputs {
  micReady: boolean;
  connected: boolean;
  /** The particle body is on screen, or it is known that it never will be (no WebGPU). */
  bodyReady: boolean;
  /** The user is talking (local VAD or the backend hears them). */
  userActive: boolean;
  /** Anything else is already happening in the conversation (assistant audio, a response, a tool). */
  conversationActive: boolean;
}

export const greetingDefaults = {
  /** Everything must have been ready and quiet this long before the greeting (ms). */
  settleMs: 900,
};

export class GreetingGate {
  status: GreetingStatus = "waiting";
  private readySince: number | null = null;
  constructor(private readonly options = greetingDefaults) {}

  get done() { return this.status === "sent" || this.status === "suppressed"; }

  /** Returns true exactly once: when the greeting should be spoken now. `now` in ms. */
  update(inputs: GreetingInputs, now: number): boolean {
    if (this.done) return false;
    const ready = inputs.micReady && inputs.connected && inputs.bodyReady;
    // Only speech while a session can hear it counts: before connecting there is no conversation yet.
    if (inputs.connected && (inputs.userActive || inputs.conversationActive)) { this.status = "suppressed"; return false; }
    if (!ready) { this.readySince = null; this.status = "waiting"; return false; }
    this.readySince ??= now;
    this.status = "settling";
    if (now - this.readySince < this.options.settleMs) return false;
    this.status = "sent";
    return true;
  }

  /** Marks the greeting as given (e.g. triggered by hand), so the automatic one never follows. */
  markSent() { this.status = "sent"; }
}

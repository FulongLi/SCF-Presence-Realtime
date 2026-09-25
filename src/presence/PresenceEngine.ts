import { SPECTRUM_BANDS } from "../audio/spectrum";
import type { MicFrame } from "../audio/microphone/MicrophoneListener";
import { FocusImpulse } from "./focus";
import { clamp01, createSignal, type PresenceMode, type PresenceSignal, type PresenceSignalSource } from "./signal";

export interface MicInput { read(dt: number): MicFrame | null }

/**
 * What the voice session knows about the conversation, reduced to what the body needs.
 * These are semantic hints from the backend's own events (Realtime turns and responses, or GPT-Live
 * transcripts and delegations); low-level physical responses (loudness, emphasis, spectrum) stay local
 * and immediate.
 */
export interface ConversationHints {
  /** A voice session is connected; its events are authoritative for turn timing. */
  live: boolean;
  /** The backend hears the user (Realtime: speech_started…speech_stopped; GPT-Live: recent input transcript). */
  userSpeaking: boolean;
  /** The user's turn ended or a response is being generated, and no assistant audio is playing yet. */
  awaitingResponse: boolean;
  /** A native visual tool call is executing. */
  toolActive: boolean;
  /**
   * Full duplex (GPT-Live): the user may talk while the assistant is audible (backchannels, overlap), and
   * the protocol has no barge-in event. An audible assistant then stays "speaking"; the user takes the
   * floor when the assistant's audio actually stops while they keep talking (a cut). Omitted: turn-based
   * (Realtime), where OpenAI's turn detection decides and `userSpeaking` always wins.
   */
  fullDuplex?: boolean;
}
export const NO_CONVERSATION: ConversationHints = { live: false, userSpeaking: false, awaitingResponse: false, toolActive: false };
/** Hints are read every frame, so time-bounded ones (an awaited response that never starts) expire. */
export interface ConversationSource { hints(now: number): ConversationHints }

export const engineDefaults = {
  /** Assistant audio louder than this is considered audible speech. */
  audibleLevel: 0.035,
  /** Silence that ends an assistant speaking turn. */
  speakingRelease: 0.55,
  /** Assistant audio frames older than this are treated as silence (remote track gone quiet). */
  audioStale: 0.25,
  /** Microphone activity is ignored this long after assistant audio ends (speaker echo). */
  echoGuard: 0.4,
  /** After an interruption, playout still in the jitter buffer must not reopen speaking. */
  interruptHold: 0.35,
  /** A user utterance this long is treated as a conversational turn (offline inference only). */
  minTurn: 0.5,
  /** Offline only: inferred thinking lasts at most this long without a live session. */
  inferredThinking: 6,
  /** Full duplex: assistant silence this long while the user is talking is a cut (the user took the floor). */
  duplexCut: 0.2,
};

const stateTargets: Record<PresenceMode, { energy: number; warmth: number }> = {
  idle: { energy: 0.08, warmth: 0.35 },
  listening: { energy: 0.16, warmth: 0.4 },
  thinking: { energy: 0.34, warmth: 0.38 },
  speaking: { energy: 0.28, warmth: 0.55 },
};
const approach = (value: number, target: number, rate: number, dt: number) =>
  value + (target - value) * (1 - Math.exp(-rate * dt));

/**
 * Core Presence: turns microphone frames, the real assistant audio and Realtime conversation hints
 * into one normalized signal for the particle body.
 *
 *   local microphone VAD ─► listening (immediate), acoustic focus, user amplitude
 *   voice backend events ─► listening/thinking timing, barge-in
 *   remote assistant audio ─► speaking, amplitude, spectrum
 *
 * The engine does not know which backend is connected: Realtime and GPT-Live differ only in the hints.
 */
export class PresenceEngine implements PresenceSignalSource {
  readonly signal: PresenceSignal = createSignal();
  readonly focusImpulse = new FocusImpulse();
  mic: MicInput | null = null;
  /** Development override; production never sets it. */
  override: PresenceMode | null = null;
  private conversation: ConversationSource | null = null;
  private level = 0;
  private audioAt = -Infinity;
  private sounding = false;
  private quiet = 0;
  private speakingEnded = -Infinity;
  private heldUntil = -Infinity;
  private readonly bands = new Float32Array(SPECTRUM_BANDS);
  private userVoiced = false;
  private thinkingUntil = -Infinity;
  private listenedUntil = -Infinity;
  private spokeAt = -Infinity;
  /** Assistant audio stopped while a full-duplex user kept talking (diagnostics). */
  cuts = 0;
  /** Seconds from the end of the user's speech to the first audible assistant reply (diagnostics). */
  replyLatency: number | null = null;
  /** Called when the body starts speaking (audible assistant audio), e.g. for latency diagnostics. */
  onSpeakingStart: ((now: number) => void) | null = null;
  constructor(private readonly config = engineDefaults) {}

  /** The analysed remote assistant track: this is the actual voice, not an estimate. */
  assistantAudio(amplitude: number, bands: ArrayLike<number>, now: number) {
    this.level = clamp01(amplitude);
    for (let i = 0; i < this.bands.length; i++) this.bands[i] = clamp01(bands[i]);
    this.audioAt = now;
  }

  /** Semantic turn/response state from the voice session (null: no session). */
  setConversation(source: ConversationSource | null) { this.conversation = source; }

  /**
   * The assistant's output was cut off (the user barged in). Speaking ends at once, without waiting for
   * the audio release; the user is speaking, so the echo guard does not apply.
   */
  interrupt(now: number) {
    this.sounding = false; this.quiet = 0; this.level = 0; this.audioAt = -Infinity;
    this.speakingEnded = -Infinity;
    this.heldUntil = now + this.config.interruptHold;
  }

  triggerFocus(strength: number, now: number) { return this.focusImpulse.trigger(strength, now); }

  /** Attaches (or with null, detaches) the local microphone analysis. */
  setMicrophone(input: MicInput | null) { this.mic = input; }

  sample(elapsed: number, now: number): PresenceSignal {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const c = this.config;
    const s = this.signal;
    const h = this.conversation?.hints(now) ?? NO_CONVERSATION;
    const frame = this.mic?.read(dt) ?? null;
    // Assistant audio: audible gate with a release, so syllable gaps do not flicker the state.
    const level = now - this.audioAt > c.audioStale || now < this.heldUntil ? 0 : this.level;
    if (level > c.audibleLevel) {
      this.quiet = 0;
      this.sounding = true;
    } else if (this.sounding) {
      this.quiet += dt;
      // Full duplex has no barge-in event: the assistant's audio stopping under the user's voice is the cut.
      // The local VAD says whether the user is talking right now (the transcript hint lags and lingers, so
      // a backchannel followed by a pause between the assistant's sentences is not mistaken for a cut).
      const userNow = frame ? frame.voiced : h.userSpeaking;
      if (h.live && h.fullDuplex && userNow && this.quiet > c.duplexCut) {
        this.cuts++;
        this.interrupt(now);
      } else if (this.quiet > c.speakingRelease) { this.sounding = false; this.speakingEnded = now; }
    }
    // Microphone: suppressed while the assistant is audible (speaker echo is not the user).
    // Barge-in is decided by the backend (Realtime turn detection, or a full-duplex cut above).
    const echo = this.sounding || now - this.speakingEnded < c.echoGuard;
    const voiced = Boolean(frame?.voiced) && !echo;
    // Without a live session, a finished utterance is inferred to start a thought.
    if (!h.live && this.userVoiced && !voiced && (frame?.utterance ?? 0) >= c.minTurn && !this.sounding) {
      this.thinkingUntil = now + c.inferredThinking;
    }
    this.userVoiced = voiced;
    if (frame?.emphasis && (voiced || (h.live && h.userSpeaking && !echo))) this.focusImpulse.trigger(frame.emphasis, now);

    let mode: PresenceMode;
    if (this.override) mode = this.override;
    else if (h.live && h.userSpeaking && !(h.fullDuplex && this.sounding)) mode = "listening";
    else if (this.sounding) mode = "speaking";
    else if (voiced) mode = "listening";
    else if (h.live ? h.awaitingResponse || h.toolActive : now < this.thinkingUntil) mode = "thinking";
    else mode = "idle";
    if (mode === "speaking" || mode === "listening") this.thinkingUntil = -Infinity;
    if (mode !== s.mode && !this.override) {
      if (s.mode === "listening") this.listenedUntil = now;
      if (mode === "speaking") {
        if (this.listenedUntil > this.spokeAt) this.replyLatency = now - this.listenedUntil;
        this.spokeAt = now;
        this.onSpeakingStart?.(now);
      }
    }
    s.mode = mode;

    const target = stateTargets[mode];
    s.energy = approach(s.energy, target.energy, 2, dt);
    s.warmth = approach(s.warmth, target.warmth, 2, dt);
    const focus = mode === "listening" ? 0.9 : 0;
    s.focus = approach(s.focus, focus, focus > s.focus ? 3.5 : 2.2, dt);
    const thinking = mode === "thinking" ? 0.5 + target.energy * 0.5 : 0;
    s.thinking = approach(s.thinking, thinking, thinking > s.thinking ? 2.2 : 3, dt);
    const user = mode === "listening" && !echo ? clamp01(frame?.level ?? 0) : 0;
    s.userAmplitude = approach(s.userAmplitude, user, user > s.userAmplitude ? 20 : 7, dt);
    s.assistantAmplitude = approach(s.assistantAmplitude, mode === "speaking" ? level : 0, 18, dt);
    const decay = Math.exp(-dt * 6);
    for (let i = 0; i < s.assistantBands.length; i++) {
      s.assistantBands[i] = mode === "speaking" && level > 0 ? this.bands[i] : s.assistantBands[i] * decay;
    }
    s.acousticFocus = this.focusImpulse.sample(now);
    return s;
  }

  /** Clears stale conversational state, e.g. when a session drops mid-response. */
  reset() {
    this.level = 0; this.audioAt = -Infinity; this.sounding = false; this.quiet = 0;
    this.speakingEnded = this.heldUntil = -Infinity;
    this.userVoiced = false; this.thinkingUntil = -Infinity;
    this.listenedUntil = this.spokeAt = -Infinity;
    this.focusImpulse.reset();
  }
}

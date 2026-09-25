import { AssistantAudio, type PlaybackState } from "../audio/assistant";
import { MicrophoneListener, microphonePermission, requestMicrophone } from "../audio/microphone/MicrophoneListener";
import { LiveClient, type LiveEnvironment } from "../live/client";
import type { LiveEvent } from "../live/events";
import { browserLiveEnvironment } from "../live/transport";
import { RealtimeClient, type RealtimeEnvironment } from "../realtime/client";
import type { RealtimeEvent } from "../realtime/events";
import { browserEnvironment } from "../realtime/transport";
import { DEFAULT_VOICE_BACKEND, type VoiceBackend } from "../voice/backend";
import type { ConnectionState } from "../voice/client";
import { ToolExecutor, type ToolRunner } from "../voice/tools/executor";
import { VisualActionController } from "../visual-actions/controller";
import { createBrowserResolver, type VisualResolver } from "../visual-resolver";
import { PresenceEngine } from "./PresenceEngine";

export type MicState = "checking" | "prompt" | "requesting" | "ready" | "denied" | "unavailable";

/** The little the stage ever shows. Everything else is expressed by the body. */
export interface PresenceUi {
  mic: MicState;
  connection: ConnectionState;
  error: string | null;
  /** Autoplay policy needs one tap before the voice can be heard. */
  needsGesture: boolean;
  playback: PlaybackState;
}

/** The voice backend adapters PresenceController can drive (both implement VoiceClient). */
export type ActiveVoiceClient = RealtimeClient | LiveClient;

export interface VoiceEnvironments { realtime: RealtimeEnvironment; live: LiveEnvironment }
export const browserEnvironments: VoiceEnvironments = { realtime: browserEnvironment, live: browserLiveEnvironment };

/** Lightweight timings for manual A/B comparison (?debug=1), measured the same way for both backends. */
export interface VoiceTimings {
  /** Connect start → session ready (Realtime: data channel open; Live: session.started). */
  connectMs: number | null;
  /** End of the user's speech → first audible assistant audio. */
  replyMs: number | null;
  /** A tool result returned to the model → the next audible assistant audio (the spoken continuation). */
  resultToAudioMs: number | null;
}

export const presenceDefaults = {
  /** A connected session with no conversation for this long ends (and releases the microphone) to save cost. */
  idleEndMs: 10 * 60_000,
};

const INITIAL_UI: PresenceUi = { mic: "checking", connection: "disconnected", error: null, needsGesture: false, playback: "idle" };
const emptyTimings = (): VoiceTimings => ({ connectMs: null, replyMs: null, resultToAudioMs: null });

/**
 * Owns the whole voice ⇄ body loop for one page:
 *
 *   one microphone stream ─┬─► voice backend (WebRTC): RealtimeClient | LiveClient ──► OpenAI
 *                          └─► MicrophoneListener (clone) ─► PresenceEngine (listening, focus)
 *   remote assistant track ──► AssistantAudio (playback + analysis) ─► PresenceEngine (speaking)
 *   backend events ──────────► PresenceEngine hints (turns, thinking, barge-in)
 *   visual function calls ───► ToolExecutor ─► VisualActionController ─► VisualResolver ─► particle morph
 *
 * Both backends share everything except the protocol adapter; the body never knows which one spoke.
 * Construction is side-effect free (safe during server rendering); start() touches the browser.
 */
export class PresenceController {
  readonly engine = new PresenceEngine();
  readonly visual: VisualActionController;
  readonly resolver: VisualResolver;
  readonly executor: ToolExecutor;
  readonly assistant: AssistantAudio;
  readonly listener: MicrophoneListener;
  backend: VoiceBackend;
  client: ActiveVoiceClient;
  timings: VoiceTimings = emptyTimings();
  ui: PresenceUi = INITIAL_UI;
  private readonly subscribers = new Set<() => void>();
  /** The one tool runner both backends use: the shared executor, plus result timing. */
  private readonly runner: ToolRunner;
  private stream?: MediaStream;
  private generation = 0;
  private lastActivity = 0;
  private connectingSince: number | null = null;
  private resultAt = -Infinity;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly environments: VoiceEnvironments = browserEnvironments,
    backend: VoiceBackend = DEFAULT_VOICE_BACKEND,
    private readonly options = presenceDefaults,
  ) {
    this.resolver = createBrowserResolver();
    this.visual = new VisualActionController(this.resolver.resolve, (error, action) => {
      if (process.env.NODE_ENV === "development") console.warn("[SCF] Visual Action could not be resolved", action, error);
    });
    this.executor = new ToolExecutor(this.visual);
    this.runner = {
      execute: async (name, args) => {
        const execution = await this.executor.execute(name, args);
        this.resultAt = performance.now();
        return execution;
      },
    };
    this.assistant = new AssistantAudio(this.engine, playback => this.update({ playback }));
    this.listener = new MicrophoneListener(() => this.microphoneLost());
    this.engine.onSpeakingStart = now => this.speakingStarted(now * 1000);
    this.backend = backend;
    this.client = this.createClient(backend);
    this.engine.setConversation(this.client);
  }

  subscribe = (callback: () => void) => { this.subscribers.add(callback); return () => { this.subscribers.delete(callback); }; };
  getSnapshot = () => this.ui;
  getServerSnapshot = () => INITIAL_UI;

  /** Checks permission without prompting; a previously granted microphone starts the session directly. */
  start() {
    const generation = ++this.generation;
    this.idleTimer = setInterval(() => this.checkIdle(), 15_000);
    void microphonePermission().then(state => {
      if (generation !== this.generation) return;
      if (state === "granted") void this.begin(false);
      else this.update({ mic: state === "denied" ? "denied" : "prompt" });
    });
  }

  /** The "Allow microphone" button: a user gesture, so audio may start too. */
  allowMicrophone() { void this.begin(true); }

  retry() { void this.begin(true); }

  /** Any pointer or key press on the page. */
  gesture() {
    this.listener.resume();
    this.assistant.prime();
    if (this.ui.needsGesture || this.ui.connection === "ended") void this.begin(true);
  }

  /**
   * Switches the voice backend (A/B testing). The current session is closed, backend-specific state is
   * dropped with its client, and a new session starts on the same microphone stream when one is open.
   * The body, the microphone, the audio graph and any visual on show are untouched.
   */
  setBackend(backend: VoiceBackend) {
    if (backend === this.backend) return;
    const previous = this.client;
    this.backend = backend;
    this.client = this.createClient(backend);
    previous.disconnect();
    this.assistant.detach();
    this.engine.interrupt(performance.now() / 1000);
    this.engine.setConversation(this.client);
    this.timings = emptyTimings();
    this.connectingSince = null;
    this.resultAt = -Infinity;
    this.update({ connection: this.client.connection, error: null });
    const live = this.stream?.getAudioTracks().some(track => track.readyState === "live");
    if (this.ui.mic === "ready" && live && !this.ui.needsGesture && this.stream) this.client.connect(this.stream);
  }

  /** Page teardown (and React StrictMode's simulated unmount): no session or microphone may outlive it. */
  stop() {
    this.generation++;
    clearInterval(this.idleTimer);
    this.client.disconnect();
    this.releaseMicrophone();
    this.assistant.detach();
    this.visual.cancel();
    // An in-flight microphone request is abandoned by the generation bump; start() re-checks permission.
    this.update({ mic: "checking", needsGesture: false });
  }

  dispose() { this.stop(); this.assistant.dispose(); }

  private createClient(backend: VoiceBackend): ActiveVoiceClient {
    // Late callbacks from a client that has been switched away from are ignored. (No callback runs
    // during construction, so `created` is always initialized when `current()` is called.)
    const current = () => created === this.client;
    const onRemoteStream = (stream: MediaStream | null) => {
      if (!current()) return;
      if (stream) this.assistant.attach(stream); else this.assistant.detach();
    };
    const onStatus = (connection: ConnectionState, error: string | null) => { if (current()) this.sessionStatus(connection, error); };
    const created: ActiveVoiceClient = backend === "live"
      ? new LiveClient(this.runner, this.environments.live, {
        onState: state => onStatus(state.connection, state.error),
        onEvent: event => { if (current()) this.liveEvent(event); },
        onRemoteStream,
      })
      : new RealtimeClient(this.runner, this.environments.realtime, {
        onState: state => onStatus(state.connection, state.error),
        onEvent: event => { if (current()) this.realtimeEvent(event); },
        onRemoteStream,
      });
    return created;
  }

  private async begin(fromGesture: boolean) {
    if (this.ui.mic === "requesting") return;
    const generation = this.generation;
    // Without a gesture the voice might be muted by autoplay policy: wait for one tap instead of
    // opening a session that talks silently.
    const audio = this.assistant.prime();
    if (!fromGesture && audio !== "running") { this.update({ needsGesture: true }); return; }
    this.update({ needsGesture: false });
    let stream = this.stream;
    if (!stream?.getAudioTracks().some(track => track.readyState === "live")) {
      this.update({ mic: "requesting" });
      try {
        stream = await requestMicrophone();
      } catch (error) {
        if (generation !== this.generation) return;
        const denied = error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError");
        this.update({ mic: denied ? "denied" : "unavailable" });
        return;
      }
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.listener.attach(stream);
      this.engine.setMicrophone(this.listener);
    }
    this.update({ mic: "ready" });
    this.client.connect(stream);
  }

  private releaseMicrophone() {
    this.engine.setMicrophone(null);
    this.listener.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = undefined;
  }

  private microphoneLost() {
    this.client.disconnect();
    this.releaseMicrophone();
    this.update({ mic: "prompt" });
  }

  private checkIdle() {
    const now = performance.now();
    if (this.client.connection !== "connected" || this.client.busy(now)) return;
    if (now - this.lastActivity > this.options.idleEndMs) {
      this.client.disconnect("ended");
      this.releaseMicrophone();
    }
  }

  private sessionStatus(connection: ConnectionState, error: string | null) {
    const now = performance.now();
    if ((connection === "connecting" || connection === "reconnecting") && this.connectingSince === null) this.connectingSince = now;
    if (connection === "connected" && this.ui.connection !== "connected") {
      this.lastActivity = now;
      if (this.connectingSince !== null) this.timings.connectMs = Math.round(now - this.connectingSince);
    }
    if (connection !== "connecting" && connection !== "reconnecting") this.connectingSince = null;
    // A session that is gone must not leave the body speaking or thinking.
    if (connection !== "connected" && this.ui.connection === "connected") this.engine.interrupt(now / 1000);
    if (connection !== this.ui.connection || error !== this.ui.error) {
      this.update({ connection, error: connection === "error" ? error : null });
    }
  }

  private realtimeEvent(event: RealtimeEvent) {
    if (event.type === "user.speech_started" || event.type === "response.started") this.lastActivity = performance.now();
    // Barge-in: OpenAI cut the unplayed audio; speaking ends now and listening takes over.
    if (event.type === "audio.cleared") this.engine.interrupt(performance.now() / 1000);
    if (event.type === "error" && process.env.NODE_ENV === "development") console.warn("[SCF] Realtime error", event);
  }

  /**
   * GPT-Live is full duplex and reports no barge-in: interruptions reach the body as the assistant's audio
   * stopping under the user's voice (PresenceEngine `fullDuplex`), so there is nothing to cut here.
   */
  private liveEvent(event: LiveEvent) {
    if (event.type === "transcript.user" || event.type === "transcript.assistant" || event.type === "delegation.created") this.lastActivity = performance.now();
    if (event.type === "error" && process.env.NODE_ENV === "development") console.warn("[SCF] GPT-Live error", event);
  }

  private speakingStarted(now: number) {
    if (this.engine.replyLatency !== null) this.timings.replyMs = Math.round(this.engine.replyLatency * 1000);
    if (now - this.resultAt < 15_000) this.timings.resultToAudioMs = Math.round(now - this.resultAt);
    this.resultAt = -Infinity;
  }

  private update(patch: Partial<PresenceUi>) {
    const next = { ...this.ui, ...patch };
    if ((Object.keys(patch) as (keyof PresenceUi)[]).every(key => next[key] === this.ui[key])) return;
    this.ui = next;
    for (const callback of this.subscribers) callback();
  }
}

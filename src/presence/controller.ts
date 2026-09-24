import { AssistantAudio, type PlaybackState } from "../audio/assistant";
import { MicrophoneListener, microphonePermission, requestMicrophone } from "../audio/microphone/MicrophoneListener";
import { RealtimeClient, type RealtimeEnvironment } from "../realtime/client";
import type { RealtimeEvent } from "../realtime/events";
import type { ConnectionState, RealtimePresenceState } from "../realtime/state";
import { ToolExecutor } from "../realtime/tools/executor";
import { browserEnvironment } from "../realtime/transport";
import { VisualActionController } from "../visual-actions/controller";
import { resolveVisualTarget } from "../visual-actions/resolve";
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

export const presenceDefaults = {
  /** A connected session with no conversation for this long ends (and releases the microphone) to save cost. */
  idleEndMs: 10 * 60_000,
};

const INITIAL_UI: PresenceUi = { mic: "checking", connection: "disconnected", error: null, needsGesture: false, playback: "idle" };

/**
 * Owns the whole voice ⇄ body loop for one page:
 *
 *   one microphone stream ─┬─► RealtimeClient (WebRTC) ──► OpenAI Realtime
 *                          └─► MicrophoneListener (clone) ─► PresenceEngine (listening, focus)
 *   remote assistant track ──► AssistantAudio (playback + analysis) ─► PresenceEngine (speaking)
 *   Realtime events ─────────► PresenceEngine hints (turns, thinking, barge-in)
 *   native function calls ───► ToolExecutor ─► VisualActionController ─► particle morph
 *
 * Construction is side-effect free (safe during server rendering); start() touches the browser.
 */
export class PresenceController {
  readonly engine = new PresenceEngine();
  readonly visual: VisualActionController;
  readonly executor: ToolExecutor;
  readonly client: RealtimeClient;
  readonly assistant: AssistantAudio;
  readonly listener: MicrophoneListener;
  ui: PresenceUi = INITIAL_UI;
  private readonly subscribers = new Set<() => void>();
  private stream?: MediaStream;
  private generation = 0;
  private lastActivity = 0;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(environment: RealtimeEnvironment = browserEnvironment, private readonly options = presenceDefaults) {
    this.visual = new VisualActionController(resolveVisualTarget, (error, action) => {
      if (process.env.NODE_ENV === "development") console.warn("[SCF] Visual Action could not be resolved", action, error);
    });
    this.executor = new ToolExecutor(this.visual);
    this.assistant = new AssistantAudio(this.engine, playback => this.update({ playback }));
    this.listener = new MicrophoneListener(() => this.microphoneLost());
    this.client = new RealtimeClient(this.executor, environment, {
      onState: state => this.sessionState(state),
      onEvent: event => this.sessionEvent(event),
      onRemoteStream: stream => stream ? this.assistant.attach(stream) : this.assistant.detach(),
    });
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
    const s = this.client.state;
    if (s.connection !== "connected" || s.responseActive || s.audioActive || s.userSpeaking) return;
    if (performance.now() - this.lastActivity > this.options.idleEndMs) {
      this.client.disconnect("ended");
      this.releaseMicrophone();
    }
  }

  private sessionState(state: RealtimePresenceState) {
    if (state.connection === "connected" && this.ui.connection !== "connected") this.lastActivity = performance.now();
    // A session that is gone must not leave the body speaking or thinking.
    if (state.connection !== "connected" && this.ui.connection === "connected") this.engine.interrupt(performance.now() / 1000);
    if (state.connection !== this.ui.connection || state.error !== this.ui.error) {
      this.update({ connection: state.connection, error: state.connection === "error" ? state.error : null });
    }
  }

  private sessionEvent(event: RealtimeEvent) {
    if (event.type === "user.speech_started" || event.type === "response.started") this.lastActivity = performance.now();
    // Barge-in: OpenAI cut the unplayed audio; speaking ends now and listening takes over.
    if (event.type === "audio.cleared") this.engine.interrupt(performance.now() / 1000);
    if (event.type === "error" && process.env.NODE_ENV === "development") console.warn("[SCF] Realtime error", event);
  }

  private update(patch: Partial<PresenceUi>) {
    const next = { ...this.ui, ...patch };
    if ((Object.keys(patch) as (keyof PresenceUi)[]).every(key => next[key] === this.ui[key])) return;
    this.ui = next;
    for (const callback of this.subscribers) callback();
  }
}

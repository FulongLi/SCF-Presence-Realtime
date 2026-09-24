import { AudioMeter } from "./analyser";

/** Remote WebRTC speech arrives at a nominal level; this maps it to the body's full range. */
export const ASSISTANT_AUDIO_SENSITIVITY = 1.4;

export interface AudioSink { assistantAudio(amplitude: number, bands: ArrayLike<number>, now: number): void }

export interface AssistantAudioEnvironment {
  element(): HTMLAudioElement;
  context(): AudioContext;
  frame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
}

const browserEnvironment: AssistantAudioEnvironment = {
  element: () => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    return audio;
  },
  context: () => new AudioContext(),
  frame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
};

export type PlaybackState = "idle" | "playing" | "blocked";

/**
 * The assistant's real voice: the remote Realtime audio track.
 * 1. It plays through an <audio> element (echo cancellation applies to element playback, and Chrome
 *    needs a remote WebRTC stream attached to an element before Web Audio can read it).
 * 2. A parallel Web Audio graph analyses the same stream — loudness and 16 spectrum bands — and
 *    feeds the Presence. The analysis graph is never connected to the speakers, so nothing plays twice.
 */
export class AssistantAudio {
  playback: PlaybackState = "idle";
  private audio?: HTMLAudioElement;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private meter?: AudioMeter;
  private frameId = 0;
  private generation = 0;

  constructor(
    private readonly sink: AudioSink,
    private readonly onPlayback: (state: PlaybackState) => void = () => {},
    private readonly environment: AssistantAudioEnvironment = browserEnvironment,
  ) {}

  /** Creates (or resumes) the analysis context; call from a user gesture where possible. */
  prime() {
    this.context ??= this.environment.context();
    if (this.context.state === "suspended") void this.context.resume().catch(() => {});
    if (this.audio?.paused && this.audio.srcObject) this.play(this.audio);
    return this.context.state;
  }

  attach(stream: MediaStream) {
    this.detach();
    const generation = ++this.generation;
    const audio = this.audio ?? this.environment.element();
    this.audio = audio;
    audio.srcObject = stream;
    this.play(audio);
    const context = this.context ?? this.environment.context();
    this.context = context;
    if (context.state === "suspended") void context.resume().catch(() => {});
    this.meter = new AudioMeter(context);
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(this.meter.node);
    let previous: number | undefined;
    const sample: FrameRequestCallback = now => {
      if (generation !== this.generation || !this.meter) return;
      const dt = previous === undefined ? 1 / 60 : Math.min(Math.max((now - previous) / 1000, 0), 0.1);
      previous = now;
      // A suspended context reads silence; the Presence then treats the voice as absent.
      if (context.state === "running") {
        const amplitude = this.meter.sample(dt, ASSISTANT_AUDIO_SENSITIVITY, true);
        this.sink.assistantAudio(amplitude, this.meter.bands, now / 1000);
      }
      this.frameId = this.environment.frame(sample);
    };
    this.frameId = this.environment.frame(sample);
  }

  /** Stops analysis and playback of the current stream, keeping the context for the next session. */
  detach() {
    this.generation++;
    if (this.frameId) this.environment.cancelFrame(this.frameId);
    this.frameId = 0;
    this.source?.disconnect(); this.meter?.disconnect();
    this.source = this.meter = undefined;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.setPlayback("idle");
  }

  dispose() {
    this.detach();
    if (this.context) void this.context.close().catch(() => {});
    this.context = this.audio = undefined;
  }

  private play(audio: HTMLAudioElement) {
    const generation = this.generation;
    void Promise.resolve(audio.play()).then(
      () => { if (generation === this.generation) this.setPlayback("playing"); },
      // Autoplay policy: the next pointer or key press calls prime() and retries.
      () => { if (generation === this.generation) this.setPlayback("blocked"); },
    );
  }

  private setPlayback(state: PlaybackState) {
    if (this.playback === state) return;
    this.playback = state;
    this.onPlayback(state);
  }
}

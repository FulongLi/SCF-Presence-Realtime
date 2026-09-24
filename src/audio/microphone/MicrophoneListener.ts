import { rms } from "../analyser";
import { EmphasisDetector } from "./emphasis";
import { VoiceActivityDetector } from "./vad";

export interface MicFrame {
  /** Voice activity after attack/hangover smoothing. */
  voiced: boolean;
  /** Floor-relative loudness in [0, 1]. */
  level: number;
  /** Duration of the current or most recent utterance, in seconds. */
  utterance: number;
  /** Acoustic emphasis event strength for this frame; 0 when none. */
  emphasis: number;
}
export type MicPermission = "granted" | "denied" | "prompt" | "unknown";

export async function microphonePermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch { return "unknown"; }
}

/**
 * The single microphone request of the page. The same stream feeds both OpenAI (its track is sent
 * over WebRTC) and the local body analysis (a clone of that track), so the user is asked once.
 */
export async function requestMicrophone(): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("microphone-unavailable");
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

interface AudioFrame { numberOfFrames: number; copyTo(destination: Float32Array, options: { planeIndex: number; format: "f32-planar" }): void; close(): void }
type TrackProcessor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioFrame> };

/**
 * Local-only microphone analysis for the body: voice activity, loudness and acoustic emphasis.
 * No recording, transcription, playback or network transfer happens here; the audio OpenAI hears
 * travels separately over WebRTC.
 * Where supported, raw frames are read straight from the track (MediaStreamTrackProcessor), which
 * needs no AudioContext. Otherwise an AnalyserNode is used, resumed on first interaction.
 */
export class MicrophoneListener {
  readonly vad = new VoiceActivityDetector();
  readonly emphasis = new EmphasisDetector();
  private track?: MediaStreamTrack;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private samples?: Float32Array<ArrayBuffer>;
  private reader?: ReadableStreamDefaultReader<AudioFrame>;
  private sum = 0;
  private count = 0;
  private lastRms = 0;
  private readonly frame: MicFrame = { voiced: false, level: 0, utterance: 0, emphasis: 0 };
  constructor(private readonly onEnded: () => void = () => {}) {}

  get running() { return Boolean(this.track); }

  /** Analyses a clone of the stream's audio track; stopping the analysis never stops the original. */
  attach(stream: MediaStream) {
    this.stop();
    const original = stream.getAudioTracks()[0];
    if (!original) throw new Error("microphone-unavailable");
    const track = original.clone();
    this.track = track;
    // The clone ends with its source (device unplugged, permission revoked).
    original.addEventListener("ended", () => { if (this.track === track) { this.stop(); this.onEnded(); } }, { once: true });
    const Processor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;
    if (Processor) {
      this.reader = new Processor({ track }).readable.getReader();
      void this.pump(this.reader);
      return;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser); // Never connected to the speakers.
    Object.assign(this, { context, source, analyser, samples: new Float32Array(analyser.fftSize) });
    void context.resume().catch(() => {});
  }

  private async pump(reader: ReadableStreamDefaultReader<AudioFrame>) {
    let buffer = new Float32Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        try {
          if (buffer.length < value.numberOfFrames) buffer = new Float32Array(value.numberOfFrames);
          const view = buffer.subarray(0, value.numberOfFrames);
          value.copyTo(view, { planeIndex: 0, format: "f32-planar" });
          for (let i = 0; i < view.length; i++) this.sum += view[i] * view[i];
          this.count += view.length;
        } finally { value.close(); }
      }
    } catch { /* the track stopped */ }
  }

  /** The AnalyserNode fallback may be held by autoplay policy until the first interaction. */
  resume() { if (this.context?.state === "suspended") void this.context.resume().catch(() => {}); }

  /** Called from the render loop with the frame time. */
  read(dt: number): MicFrame | null {
    let energy: number;
    if (this.reader) {
      // Frames arrive every ~10 ms; between them the last measurement stands.
      if (this.count) { this.lastRms = Math.sqrt(this.sum / this.count); this.sum = this.count = 0; }
      energy = this.lastRms;
    } else {
      if (!this.analyser || !this.samples || this.context?.state !== "running") return null;
      this.analyser.getFloatTimeDomainData(this.samples);
      energy = rms(this.samples);
    }
    const vad = this.vad.sample(energy, dt);
    this.frame.voiced = vad.voiced;
    this.frame.level = vad.level;
    this.frame.utterance = vad.utterance;
    this.frame.emphasis = this.emphasis.sample(vad.level, vad.voiced, vad.utterance, dt);
    return this.frame;
  }

  stop() {
    void this.reader?.cancel().catch(() => {});
    this.track?.stop();
    this.source?.disconnect();
    void this.context?.close().catch(() => {});
    this.track = this.source = this.analyser = this.context = this.samples = this.reader = undefined;
    this.sum = this.count = this.lastRms = 0;
    this.vad.reset(); this.emphasis.reset();
  }
}

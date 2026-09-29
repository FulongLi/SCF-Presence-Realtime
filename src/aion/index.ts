import type { PresenceSignal } from "../presence/signal";
import { AionBody, type AionBodyId } from "./body";
import { FigureAnimator } from "./figure/pose";
import { AION_IDENTITY } from "./identity";
import { GreetingGate } from "./greeting";
import { AionStateMachine, type AionGesture, type AionState } from "./state";

export { AION_IDENTITY } from "./identity";
export type { AionBodyId } from "./body";
export type { AionState } from "./state";

/** What the particle runtime reads each frame for the persistent body. */
export interface BodyFrame {
  /** Weight of the figure layer (0: sphere, 1: figure). */
  level: number;
  /** World-space skeleton anchors, vec4 per anchor (see figure/skeleton.ts). */
  anchors: Float32Array;
  /** Accumulated turn of the faint halo around the head (radians); it turns only while thinking. */
  orbit: number;
}
export interface BodySource { sample(dt: number, now: number, calm: boolean): BodyFrame }

export interface AionInputs {
  /** The PresenceEngine's signal, already sampled this frame. */
  signal(): PresenceSignal;
  /** A temporary visual is resolving, forming or held. */
  presenting(): boolean;
}

/**
 * Aion: identity (who), state (what it is doing) and body (which form it occupies), kept apart.
 * The runtime samples it once per frame as the body source; conversation code only calls setBody,
 * gesture and the greeting gate. Nothing here knows about WebGPU or the voice protocol.
 */
export class Aion implements BodySource {
  readonly identity = AION_IDENTITY;
  readonly body = new AionBody();
  readonly state = new AionStateMachine();
  readonly figure = new FigureAnimator();
  readonly greeting = new GreetingGate();
  private orbit = 0;
  private readonly frame: BodyFrame;

  constructor(private readonly inputs: AionInputs) {
    this.figure.sample(0, "idle", 0);
    this.frame = { level: 0, anchors: this.figure.anchors, orbit: 0 };
  }

  get currentState(): AionState { return this.state.state; }
  get currentBody(): AionBodyId { return this.body.form; }

  /** Changes the persistent body; false when it already is that body. */
  setBody(form: AionBodyId) { return this.body.set(form); }

  gesture(name: AionGesture) { this.state.trigger(name); }

  sample(dt: number, now: number, calm = false): BodyFrame {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    const signal = this.inputs.signal();
    const state = this.state.update({ mode: signal.mode, presenting: this.inputs.presenting() }, now);
    this.frame.level = this.body.sample(step);
    // The figure's pose is only computed while any of it is visible.
    if (this.frame.level > 0 || this.body.form === "figure") {
      this.figure.sample(step, state, now - this.state.since, signal.assistantAmplitude, calm);
    }
    this.orbit = (this.orbit + step * 0.35 * signal.thinking * (calm ? 0.3 : 1)) % (Math.PI * 2);
    this.frame.orbit = this.orbit;
    return this.frame;
  }
}

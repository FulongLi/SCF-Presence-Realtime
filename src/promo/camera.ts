import type { StagePose } from "../particle/ParticleRuntime";
import { smootherstep } from "./transitions";

/**
 * The film's camera: the product's own fitted framing, with slow, almost subconscious staging. It never
 * orbits, whips or shakes; each move eases in and out and the body stays readable throughout.
 */
export const REST_POSE: StagePose = { yaw: 0, pitch: 0, distance: 1, lift: 0 };

export const POSES = {
  rest: REST_POSE,
  /** Opening: slightly closer and turned, settling as the body forms (gentle depth and parallax). */
  birth: { yaw: -0.07, pitch: 0.035, distance: 0.93, lift: 0.1 },
  /** Terrain: a slightly lower, turned, closer view so the relief reads as height (no orbit). */
  terrain: { yaw: 0.12, pitch: -0.07, distance: 0.8, lift: 0.4 },
  /** Holding an expression: a subconscious push-in, still frontal, so a held form never reads as a still. */
  hold: { yaw: 0, pitch: 0, distance: 0.965, lift: 0 },
  /** Outro: a gentle pullback with the body raised above the titles. */
  outro: { yaw: 0, pitch: 0, distance: 1.24, lift: 0.62 },
} as const satisfies Record<string, StagePose>;

/** Starting at `start`, the camera eases from wherever it is to `to` over `duration` seconds. */
export interface CameraMove { start: number; duration: number; to: StagePose }

const mix = (a: StagePose, b: StagePose, k: number): StagePose => ({
  yaw: a.yaw + (b.yaw - a.yaw) * k,
  pitch: a.pitch + (b.pitch - a.pitch) * k,
  distance: a.distance + (b.distance - a.distance) * k,
  lift: a.lift + (b.lift - a.lift) * k,
});

/** The camera pose at time t, given the opening pose and time-ordered, non-overlapping moves. */
export function cameraPose(initial: StagePose, moves: readonly CameraMove[], t: number): StagePose {
  let pose = initial;
  for (const move of moves) {
    if (t <= move.start) break;
    pose = mix(pose, move.to, smootherstep((t - move.start) / move.duration));
  }
  return pose;
}

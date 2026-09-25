import type { Node } from "three/webgpu";
import { cross, float, sin, smoothstep, vec3 } from "three/tsl";

/**
 * Formation: the body assembling itself from free particles (the promo film's birth; reusable for any
 * startup). It is not a second particle system. Every grain of the ordinary body gets a plan: where it
 * comes into existence, when, and how long its flight lasts. It rises, its path bends continuously toward
 * the body (a cubic curve whose last control point sits just outside its own rest place, with a shared
 * swirl), and during the last part of the flight it is captured by the ordinary body physics. When the
 * last grain has arrived every particle is exactly where the normal sphere would put it, so the handoff to
 * the living sphere is invisible: it is the same body.
 *
 * Plan layout, two vec4 per particle:
 *   launch = (start.x, start.y, start.z, launch time)
 *   path   = (flight duration, swirl, rise, phase)
 */
export interface FormationPlan {
  launch: Float32Array;
  path: Float32Array;
  /** Formation time by which every particle has arrived and been captured. */
  end: number;
}

export const formationShape = {
  /** How far outside its rest place a particle's approach begins (the last control point). */
  approach: 0.9,
  /** Lateral wandering during flight; zero at both ends of the path. */
  wobble: 0.14,
  /** Fraction of the flight after which the body's own physics takes over. */
  capture: 0.8,
  /** Seconds over which a grain comes into existence (size and light). */
  fadeIn: 0.9,
  /** Light of a free grain relative to a captured one. */
  dim: 0.55,
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * CPU reference of the GPU formation path (the material evaluates the identical expression). Used by
 * tests and tooling; `settled` is where the ordinary body currently holds the particle.
 */
export function formationState(plan: FormationPlan, index: number, rest: readonly [number, number, number], time: number,
  settled: readonly [number, number, number] = rest) {
  const l = index * 4;
  const [sx, sy, sz, at] = [plan.launch[l], plan.launch[l + 1], plan.launch[l + 2], plan.launch[l + 3]];
  const [flight, swirl, rise, phase] = [plan.path[l], plan.path[l + 1], plan.path[l + 2], plan.path[l + 3]];
  const u = clamp01((time - at) / flight);
  const p = u * u * (3 - 2 * u), q = 1 - p;
  const length = Math.hypot(rest[0], rest[1], rest[2]) + 1e-4;
  const d = [rest[0] / length, rest[1] / length, rest[2] / length];
  // cross((0, 1, 0), d) = (d.z, 0, -d.x)
  const c1 = [sx, sy + rise, sz];
  const c2 = [rest[0] + d[0] * formationShape.approach + d[2] * swirl, rest[1] + d[1] * formationShape.approach, rest[2] + d[2] * formationShape.approach - d[0] * swirl];
  const w = Math.sin(p * Math.PI) * formationShape.wobble;
  const wobble = [Math.sin(time * 1.3 + phase) * w, Math.sin(time * 0.9 + phase * 1.7) * 0.6 * w, Math.sin(time * 1.1 + phase * 2.3) * w];
  const start = [sx, sy, sz];
  const flightPoint = [0, 1, 2].map(k => start[k] * q * q * q + c1[k] * 3 * q * q * p + c2[k] * 3 * q * p * p + rest[k] * p * p * p + wobble[k]);
  const capture = smooth(formationShape.capture, 1, u);
  const position = [0, 1, 2].map(k => flightPoint[k] + (settled[k] - flightPoint[k]) * capture) as [number, number, number];
  return { position, capture, visible: smooth(at, at + formationShape.fadeIn, time), progress: u };
}

/** GPU formation nodes for the particle material. */
export function formationNodes(launch: Node, path: Node, time: Node, rest: Node) {
  const start = launch.xyz, at = launch.w;
  const u = time.sub(at).div(path.x).clamp(0, 1);
  const p = u.mul(u).mul(float(3).sub(u.mul(2)));
  const q = float(1).sub(p);
  const direction = rest.div(rest.length().add(1e-4));
  const c1 = start.add(vec3(0, path.z, 0));
  const c2 = rest.add(direction.mul(formationShape.approach)).add(cross(vec3(0, 1, 0), direction).mul(path.y));
  const curve = start.mul(q.mul(q).mul(q)).add(c1.mul(q.mul(q).mul(p).mul(3)))
    .add(c2.mul(q.mul(p).mul(p).mul(3))).add(rest.mul(p.mul(p).mul(p)));
  const wobble = vec3(
    sin(time.mul(1.3).add(path.w)),
    sin(time.mul(0.9).add(path.w.mul(1.7))).mul(0.6),
    sin(time.mul(1.1).add(path.w.mul(2.3))),
  ).mul(sin(p.mul(Math.PI)).mul(formationShape.wobble));
  return {
    flight: curve.add(wobble),
    capture: smoothstep(formationShape.capture, 1, u),
    visible: smoothstep(at, at.add(formationShape.fadeIn), time),
  };
}

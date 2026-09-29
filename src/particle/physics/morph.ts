import type { Node } from "three/webgpu";
import { cos, float, sin, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "./uniforms";

/**
 * Per-particle morph weight. A stable hash of the rest position staggers departure and arrival
 * slightly, so a Visual Action reads as the same body reorganising rather than every grain moving
 * in lockstep. Compute and material evaluate the identical expression from the same rest buffer.
 */
export function morphWeight(rest: Node, u: PhysicsUniforms) {
  const hash = sin(rest.dot(vec3(12.9898, 78.233, 37.719))).mul(43758.5453).fract();
  const w = u.morph.mul(1.3).sub(hash.mul(0.3)).clamp(0, 1);
  return w.mul(w).mul(float(3).sub(w.mul(2)));
}

/**
 * The formed visual's rest shape, turned about the view axis by `formedAngle` (the target's own spin
 * accumulated by the runtime; 0, and so unchanged, for every target that does not spin). Compute and
 * material use the identical expression.
 */
export function formedTarget(target: Node, u: PhysicsUniforms) {
  const c = cos(u.formedAngle), s = sin(u.formedAngle);
  return vec3(target.x.mul(c).sub(target.y.mul(s)), target.x.mul(s).add(target.y.mul(c)), target.z);
}

/**
 * Per-particle weight of the persistent figure body (0: sphere, 1: figure), staggered by a second stable
 * hash so the body re-forms grain by grain rather than in lockstep. Compute and material share it.
 */
export function bodyWeight(rest: Node, u: PhysicsUniforms) {
  const hash = sin(rest.dot(vec3(41.3, 17.9, 63.1))).mul(24634.6345).fract();
  const w = u.bodyMorph.mul(1.35).sub(hash.mul(0.35)).clamp(0, 1);
  return w.mul(w).mul(float(3).sub(w.mul(2)));
}

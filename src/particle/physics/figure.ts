import type { Node } from "three/webgpu";
import { cos, float, mix, normalize, sin, vec3 } from "three/tsl";
import { FIGURE_KINDS, figureStroke } from "@/aion/figure/layout";
import type { PhysicsUniforms } from "./uniforms";

/**
 * The Particle Figure's rest position for one grain, from its binding (see aion/figure/layout.ts) and the
 * skeleton anchors the pose animator uploads each frame. Compute and material evaluate the identical
 * expression; `figurePoint()` is its CPU reference for tests.
 */
export function figureRest(bind: Node, local: Node, u: PhysicsUniforms) {
  const packed = bind.x.add(0.5).floor();
  const index = (divisor: number) => packed.div(divisor).floor().mod(16).toInt();
  const anchor = (divisor: number) => u.anchors.element(index(divisor)).xyz;
  const a = anchor(1), b = anchor(16), c = anchor(256), d = anchor(4096);
  const kind = packed.div(65536).floor();
  // Grains flow gently along their bone (zero at both ends, so joints and the head ring stay put).
  const s0 = bind.y;
  const s = s0.add(sin(u.clock.mul(figureStroke.flowSpeed).add(local.w)).mul(figureStroke.flow).mul(s0.mul(float(1).sub(s0)).mul(4)));
  const base = mix(mix(a, b, s), mix(d, c, s), bind.z);
  const direction = normalize(b.sub(a).add(vec3(0, 1e-4, 0)));
  const across = vec3(direction.y.negate(), direction.x, 0);
  // The halo about the head turns by the accumulated orbit; nothing else does.
  const halo = float(1).sub(kind.sub(FIGURE_KINDS.halo).abs().min(1));
  const co = cos(u.figureOrbit), si = sin(u.figureOrbit);
  const lx = mix(local.x, local.x.mul(co).sub(local.y.mul(si)), halo);
  const ly = mix(local.y, local.x.mul(si).add(local.y.mul(co)), halo);
  // Small positional noise; loose grains (far from their bone) drift more.
  const drift = float(0.006).add(vec3(local.x, local.y, 0).length().mul(0.06));
  const wobble = vec3(
    sin(u.clock.mul(0.7).add(local.w)),
    sin(u.clock.mul(0.53).add(local.w.mul(1.9))),
    sin(u.clock.mul(0.61).add(local.w.mul(2.7))),
  ).mul(drift);
  const position = base.add(direction.mul(lx)).add(across.mul(ly)).add(vec3(0, 0, local.z)).add(wobble);
  // Thinking lifts the halo's light a little; everything else keeps its own tone.
  const tone = bind.w.mul(float(1).add(halo.mul(u.thinking).mul(2.5)));
  return { position, tone };
}

import type { Node } from "three/webgpu";
import { abs, clamp, float, mx_fractal_noise_vec3, pow, smoothstep, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "./uniforms";
type VectorNode = Node;

export function pusherForce(position: VectorNode, seed: VectorNode, u: PhysicsUniforms) {
  // View-axis cylinder: the cursor disturbs the volume, including its back.
  const delta = position.sub(u.pusherPosition);
  const distance = delta.xy.length();
  const reach = u.radius.add(u.influence);
  const lateral = float(1).sub(smoothstep(u.radius, reach, distance));
  const halfDepth = u.depth.mul(0.5);
  const depth = float(1).sub(smoothstep(halfDepth.mul(0.7), halfDepth, abs(delta.z)));
  const influence = pow(lateral, u.falloff).mul(depth).mul(u.active);
  const speed = u.pusherVelocity.length();
  const direction = u.pusherVelocity.div(speed.add(0.0001));
  const outward = vec3(delta.xy.div(distance.add(0.0001)), 0);
  const exit = outward.add(direction.mul(u.flowBias)).add(seed.mul(u.scatter));
  const normalizedExit = exit.div(exit.length().add(0.0001));
  const shove = normalizedExit.mul(u.radial.add(speed.mul(u.movement)));
  const noise = mx_fractal_noise_vec3(
    position.mul(u.turbulenceScale).add(seed.mul(0.15)).add(
      vec3(u.clock, u.clock.mul(0.7), u.clock.mul(1.3)).mul(u.turbulenceSpeed),
    ), 2, 2, 0.5,
  );
  const wake = noise.mul(u.turbulence).mul(clamp(speed.mul(0.25), 0, 1));
  const force = shove.add(wake).mul(influence);
  return force.mul(float(1).min(u.maxForce.div(force.length().add(0.0001))));
}

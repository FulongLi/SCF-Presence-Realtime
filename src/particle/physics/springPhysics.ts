import type { Node } from "three/webgpu";
import { float, min } from "three/tsl";
import type { PhysicsUniforms } from "./uniforms";
type VectorNode = Node;

export function integrateSpring(offset: VectorNode, velocity: VectorNode, force: VectorNode, u: PhysicsUniforms) {
  // Semi-implicit integration at 120 Hz, with an implicit damping term.
  velocity.assign(velocity.add(force.sub(offset.mul(u.stiffness)).mul(u.dt)).div(float(1).add(u.damping.mul(u.dt))));
  offset.addAssign(velocity.mul(u.dt));
  const limit = min(1, u.maxOffset.div(offset.length().add(0.0001)));
  offset.mulAssign(limit);
  velocity.mulAssign(limit);
}

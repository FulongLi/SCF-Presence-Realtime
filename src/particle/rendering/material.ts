import type { Node } from "three/webgpu";
import { Color } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { float, mix, normalize, positionLocal, sin, smoothstep, uniform, uv, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "../physics/uniforms";
import { morphWeight } from "../physics/morph";
type VectorNode = Node;

export function createMaterial(rest: VectorNode, offset: VectorNode, target: VectorNode, tone: VectorNode, u: PhysicsUniforms) {
  const material = new MeshBasicNodeMaterial();
  const m = morphWeight(rest, u);
  const normal = normalize(rest.add(offset).add(vec3(0, 0.0001, 0)));
  const key = normal.dot(normalize(vec3(-0.7, 1, 1.7))).add(u.wrap).div(u.wrap.add(1)).clamp(0, 1);
  const fill = normal.dot(normalize(vec3(1, -0.3, -0.6))).add(u.wrap).div(u.wrap.add(1)).clamp(0, 1);
  // Attention and focus lift the light a little: the body "turns toward" the user.
  const attentionLight = u.attention.mul(u.listeningGlow).add(u.focusPulse.mul(u.focusGlow));
  const light = key.mul(u.key).add(fill.mul(u.fill)).add(u.ambient).add(attentionLight);
  const cool = uniform(new Color("#a8bed1"));
  const warm = uniform(new Color("#d5c5bb"));
  const color = mix(cool, warm, u.warmth.mul(0.28));
  const disturbance = offset.length().mul(0.28).clamp(0, 0.22);
  // Stable size variation keeps individual grains legible without frame-to-frame flicker.
  const grainSize = sin(rest.dot(vec3(127.1, 311.7, 74.7))).mul(0.3).add(1);
  const base = mix(rest, target, m);
  const depthSway = sin(u.clock.mul(0.5)).mul(0.07).mul(m);
  const relief = vec3(base.x.add(base.z.mul(depthSway)), base.y, base.z);
  material.positionNode = positionLocal.mul(u.size).mul(grainSize).mul(float(1).sub(m.mul(0.24))).add(relief).add(offset);
  const accentLight = smoothstep(0.25, 0.95, normal.dot(normalize(u.voiceDirection)))
    .mul(u.voiceAccent).mul(0.08).mul(u.speechGain);
  // A formed visual brightens very slightly with the voice: alive, never flickering.
  const formedLight = float(1).add(u.voiceBody.mul(u.formedShimmer).mul(0.16));
  material.colorNode = mix(color.mul(light).add(disturbance).add(accentLight), vec3(0.78, 0.9, 1).mul(tone).mul(formedLight), m);
  material.opacityNode = float(1).sub(smoothstep(0.24, 0.5, uv().sub(0.5).length()));
  material.alphaTest = 0.12;
  return material;
}

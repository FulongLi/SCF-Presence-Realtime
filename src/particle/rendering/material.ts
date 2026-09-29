import type { Node } from "three/webgpu";
import { Color } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { float, mix, normalize, positionLocal, sin, smoothstep, uniform, uv, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "../physics/uniforms";
import { bodyWeight, formedTarget, morphWeight } from "../physics/morph";
import { figureRest } from "../physics/figure";
import { formationNodes, formationShape } from "../formation";
type VectorNode = Node;

/** Optional formation inputs (see formation.ts): per-particle plan attributes and the formation clock. */
export interface FormationInputs { launch: VectorNode; path: VectorNode; time: VectorNode }
/** Aion's figure body: each particle's skeleton binding (see aion/figure/layout.ts). */
export interface FigureInputs { bind: VectorNode; local: VectorNode }

export function createMaterial(rest: VectorNode, offset: VectorNode, target: VectorNode, tone: VectorNode, u: PhysicsUniforms,
  formation?: FormationInputs, figure?: FigureInputs) {
  const material = new MeshBasicNodeMaterial();
  const m = morphWeight(rest, u);
  // The persistent body under every visual: the sphere, or the figure (weight 0 leaves the sphere unchanged).
  const figured = figure ? figureRest(figure.bind, figure.local, u) : null;
  const b = figured ? bodyWeight(rest, u) : float(0);
  const bodyRest = figured ? mix(rest, figured.position, b) : rest;
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
  const base = mix(bodyRest, formedTarget(target, u), m);
  const depthSway = sin(u.clock.mul(0.5)).mul(0.07).mul(m);
  const relief = vec3(base.x.add(base.z.mul(depthSway)), base.y, base.z);
  // Formed visuals and the figure use slightly finer grains than the sphere.
  const grain = positionLocal.mul(u.size).mul(grainSize).mul(float(1).sub(m.mul(0.24).max(b.mul(0.34))));
  // Formation: a free grain follows its flight and is captured by the body; once captured it is exactly
  // the ordinary particle (the same rest, offset and light), so the finished body is the normal sphere.
  const formed = formation ? formationNodes(formation.launch, formation.path, formation.time, rest) : null;
  material.positionNode = formed
    ? grain.mul(formed.visible).add(mix(formed.flight, relief.add(offset), formed.capture))
    : grain.add(relief).add(offset);
  const accentLight = smoothstep(0.25, 0.95, normal.dot(normalize(u.voiceDirection)))
    .mul(u.voiceAccent).mul(0.08).mul(u.speechGain);
  // A formed visual brightens very slightly with the voice: alive, never flickering.
  const formedLight = float(1).add(u.voiceBody.mul(u.formedShimmer).mul(0.16));
  const sphereColor = color.mul(light).add(disturbance).add(accentLight);
  // The figure is lit by its own tones (bright bones and joints, faint veil and dust), in the sphere's
  // palette, brightening slightly as it turns toward the user and with the voice.
  const figureLight = float(1.25).add(attentionLight.mul(2)).add(u.voiceBody.mul(0.12));
  const restColor = figured ? mix(sphereColor, color.mul(figured.tone).mul(figureLight).add(disturbance.mul(0.5)), b) : sphereColor;
  const bodyColor = mix(restColor, vec3(0.78, 0.9, 1).mul(tone).mul(formedLight), m);
  material.colorNode = formed ? bodyColor.mul(mix(float(formationShape.dim), float(1), formed.capture).mul(formed.visible)) : bodyColor;
  material.opacityNode = float(1).sub(smoothstep(0.24, 0.5, uv().sub(0.5).length()));
  material.alphaTest = 0.12;
  return material;
}

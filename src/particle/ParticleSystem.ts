import { InstancedMesh, PlaneGeometry } from "three";
import { StorageInstancedBufferAttribute } from "three/webgpu";
import { Fn, float, instanceIndex, mix, sin, storage, uniform, vec3 } from "three/tsl";
import { SPECTRUM_BANDS } from "@/audio/spectrum";
import type { ParticleConfig } from "@/config/particleDefaults";
import { createTargetPoints, type TargetPoints } from "@/visual-resolver/points";
import type { MorphTarget } from "@/visual-actions/types";
import { createSphere } from "./sphere/createSphere";
import { createUniforms } from "./physics/uniforms";
import { createFigureLayout } from "@/aion/figure/layout";
import { bodyWeight, formedTarget, morphWeight } from "./physics/morph";
import { figureRest } from "./physics/figure";
import { pusherForce } from "./physics/pusherPhysics";
import { presenceForce } from "./physics/presenceField";
import { integrateSpring } from "./physics/springPhysics";
import { createMaterial } from "./rendering/material";
import type { FormationPlan } from "./formation";

/** Builds a formation plan for the body's rest positions (see formation.ts). */
export type FormationPlanner = (rest: Float32Array, capacity: number) => FormationPlan;

export function createParticleSystem(capacity: number, config: ParticleConfig, planFormation?: FormationPlanner) {
  const sphere = createSphere(capacity, config.geometry.radius);
  const rest = storage(new StorageInstancedBufferAttribute(sphere.positions, 3), "vec3", capacity).toReadOnly();
  const seed = storage(new StorageInstancedBufferAttribute(sphere.seeds, 3), "vec3", capacity).toReadOnly();
  const offsets = storage(new StorageInstancedBufferAttribute(capacity, 3), "vec3", capacity);
  const velocities = storage(new StorageInstancedBufferAttribute(capacity, 3), "vec3", capacity);
  // The morph target is the rest shape of a Visual Action; the sphere remains the default rest.
  const targetPositions = new StorageInstancedBufferAttribute(new Float32Array(sphere.positions), 3);
  const targetTones = new StorageInstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
  const target = storage(targetPositions, "vec3", capacity).toReadOnly();
  const tones = storage(targetTones, "float", capacity).toReadOnly();
  // Aion's figure body: every grain bound to the skeleton (see aion/figure/layout.ts). Two vec4 per particle.
  const figure = createFigureLayout(capacity);
  const figureBind = storage(new StorageInstancedBufferAttribute(figure.bind, 4), "vec4", capacity).toReadOnly();
  const figureLocal = storage(new StorageInstancedBufferAttribute(figure.local, 4), "vec4", capacity).toReadOnly();
  const u = createUniforms(config);
  const compute = Fn(() => {
    const r = rest.element(instanceIndex);
    const s = seed.element(instanceIndex);
    const o = offsets.element(instanceIndex);
    const v = velocities.element(instanceIndex);
    const m = morphWeight(r, u);
    // The persistent body is the rest a temporary visual forms from and returns to: sphere or figure.
    const b = bodyWeight(r, u);
    const bodyRest = mix(r, figureRest(figureBind.element(instanceIndex), figureLocal.element(instanceIndex), u).position, b);
    const base = mix(bodyRest, formedTarget(target.element(instanceIndex), u), m);
    // The sphere's own field (breathing, listening, thinking, speech tufts) is shaped for a sphere; the
    // figure keeps only a faint trace of it (so its fine lines are not blurred) and gets its body language
    // from the pose instead.
    const sphereForce = presenceForce(r, s, u).mul(float(1).sub(m)).mul(float(1).sub(b.mul(0.94)));
    // A formed visual action still breathes and answers speech, in a restrained way: a slow travelling
    // ripple plus a speech shimmer along the view axis (depth keeps the image legible), where each
    // column of the image follows one spectrum band and grains twinkle with articulation.
    const column = base.x.div(3.2).add(0.5).clamp(0, 0.999).mul(SPECTRUM_BANDS).floor().toInt();
    const twinkle = sin(s.x.mul(40).add(u.voicePhase.mul(9))).mul(u.voiceArticulation).mul(0.012);
    const shimmer = u.spectrum.element(column).mul(0.03).add(u.voiceBody.mul(0.022)).add(twinkle).mul(u.formedShimmer);
    const ripple = vec3(0, 0, sin(u.clock.mul(0.85).add(base.x.mul(2))).mul(0.016).add(shimmer))
      .mul(m).mul(u.stiffness).mul(u.motion);
    // The figure glimmers with the voice along the view axis, never scattering its outline.
    const glimmer = vec3(0, 0, u.voiceBody.mul(0.02).add(twinkle.mul(1.5)))
      .mul(b.mul(float(1).sub(m))).mul(u.stiffness).mul(u.motion);
    const pointerScale = float(1).sub(m.mul(0.94));
    const force = pusherForce(base.add(o), s, u).mul(pointerScale).add(sphereForce).add(ripple).add(glimmer);
    integrateSpring(o, v, force, u);
  })().compute(capacity);
  // Camera-facing microdiscs preserve the original instanced material pipeline,
  // with six vertices per particle instead of a full polyhedron.
  const geometry = new PlaneGeometry(1, 1);
  const plan = planFormation?.(sphere.positions, capacity);
  if (plan && (plan.launch.length !== capacity * 4 || plan.path.length !== capacity * 4)) throw new Error("invalid-formation");
  const formationClock = uniform(0);
  // Read per instance from storage in the vertex stage: the material already uses every vertex buffer slot.
  const formation = plan ? {
    time: formationClock,
    launch: storage(new StorageInstancedBufferAttribute(plan.launch, 4), "vec4", capacity).toReadOnly().element(instanceIndex),
    path: storage(new StorageInstancedBufferAttribute(plan.path, 4), "vec4", capacity).toReadOnly().element(instanceIndex),
  } : undefined;
  const figureInputs = { bind: figureBind.element(instanceIndex), local: figureLocal.element(instanceIndex) };
  const material = createMaterial(rest.toAttribute(), offsets.toAttribute(), target.toAttribute(), tones.toAttribute(), u, formation, figureInputs);
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.frustumCulled = false;
  // Targets sampled ahead of time (a director that knows its visuals); anything else is sampled on upload.
  const prepared = new WeakMap<object, TargetPoints>();
  return {
    mesh, compute, uniforms: u, capacity,
    /** Formation clock (seconds since the formation began), when the body was built with a formation plan. */
    formation: plan ? { clock: formationClock, end: plan.end } : null,
    prepare(value: MorphTarget) { if (!prepared.has(value.visual)) prepared.set(value.visual, createTargetPoints(value.visual, capacity)); },
    setTarget(value: MorphTarget) {
      const points = prepared.get(value.visual) ?? createTargetPoints(value.visual, capacity);
      targetPositions.array.set(points.positions); targetPositions.needsUpdate = true;
      targetTones.array.set(points.tones); targetTones.needsUpdate = true;
    },
    setCount(count: number) { mesh.count = count; compute.count = count; },
    dispose() { compute.dispose(); geometry.dispose(); material.dispose(); mesh.dispose(); },
  };
}

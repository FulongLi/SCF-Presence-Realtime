import { SPECTRUM_BANDS } from "../../audio/spectrum";
import { Vector3, Vector4 } from "three";
import { ANCHOR_COUNT } from "@/aion/figure/skeleton";
import { uniform, uniformArray } from "three/tsl";
import type { ParticleConfig } from "@/config/particleDefaults";

export function createUniforms(config: ParticleConfig) {
  return {
    dt: uniform(1 / 120), clock: uniform(0), morph: uniform(0),
    pusherPosition: uniform(new Vector3()), pusherVelocity: uniform(new Vector3()),
    active: uniform(0), radius: uniform(config.pusher.radius),
    influence: uniform(config.pusher.influence), falloff: uniform(config.pusher.falloff),
    depth: uniform(config.pusher.depth), movement: uniform(config.pusher.movement),
    radial: uniform(config.pusher.radial), flowBias: uniform(config.pusher.flowBias),
    scatter: uniform(config.pusher.scatter), maxForce: uniform(config.pusher.maxForce),
    turbulence: uniform(config.pusher.turbulence),
    turbulenceScale: uniform(config.pusher.turbulenceScale),
    turbulenceSpeed: uniform(config.pusher.turbulenceSpeed),
    stiffness: uniform(config.spring.stiffness), damping: uniform(config.spring.damping),
    maxOffset: uniform(config.spring.maxOffset),
    breath: uniform(config.idle.breathing), breathFrequency: uniform(config.idle.frequency),
    drift: uniform(config.idle.drift), flow: uniform(config.idle.flow), idleSpeed: uniform(config.idle.speed),
    contraction: uniform(config.listening.contraction), coherence: uniform(config.listening.coherence),
    listeningBreath: uniform(config.listening.breath), inputResponse: uniform(config.listening.response),
    listeningGlow: uniform(config.listening.glow),
    focusContraction: uniform(config.focus.contraction), focusCoherence: uniform(config.focus.coherence),
    focusGlow: uniform(config.focus.glow),
    thoughtTurbulence: uniform(config.thinking.turbulence), rotation: uniform(config.thinking.rotation),
    thoughtTravel: uniform(config.thinking.travel),
    audioForce: uniform(config.speaking.radial), audioTurbulence: uniform(config.speaking.turbulence),
    audioFlow: uniform(config.speaking.flow), audioAccent: uniform(config.speaking.accent),
    spectrumStrength: uniform(config.speaking.spectrum),
    spectrum: uniformArray(Array<number>(SPECTRUM_BANDS).fill(0), "float"),
    voiceBody: uniform(0), voiceArticulation: uniform(0), voiceAccent: uniform(0), voiceFollow: uniform(0),
    voicePhase: uniform(0), voiceDirection: uniform(new Vector3(0.65, 0.4, 0.65)),
    attention: uniform(0), focusPulse: uniform(0), thinking: uniform(0), listeningAudio: uniform(0),
    energy: uniform(0.08), warmth: uniform(0.35), motion: uniform(1),
    // Visual Action ↔ speech blending (see morphBlend.ts).
    speechGain: uniform(1), formedShimmer: uniform(0),
    // How far a spinning formed visual has turned (radians; see MorphTarget.motion).
    formedAngle: uniform(0),
    // Aion's persistent body (see aion/body.ts): the figure layer's weight, its skeleton anchors (world
    // units, vec4 each) and the halo's accumulated turn. Weight 0 leaves the sphere exactly as before.
    bodyMorph: uniform(0),
    anchors: uniformArray(Array.from({ length: ANCHOR_COUNT }, () => new Vector4()), "vec4"),
    figureOrbit: uniform(0),
    size: uniform(config.geometry.size), ambient: uniform(config.lighting.ambient),
    key: uniform(config.lighting.key), fill: uniform(config.lighting.fill), wrap: uniform(config.lighting.wrap),
  };
}
export type PhysicsUniforms = ReturnType<typeof createUniforms>;

/** Copies live-tunable configuration into uniforms (development tuning only). */
export function syncUniforms(u: PhysicsUniforms, config: ParticleConfig) {
  const { pusher: p, spring, idle, listening, focus, thinking, speaking, lighting, geometry } = config;
  u.radius.value = p.radius; u.influence.value = p.influence; u.falloff.value = p.falloff; u.depth.value = p.depth;
  u.movement.value = p.movement; u.radial.value = p.radial; u.turbulence.value = p.turbulence;
  u.flowBias.value = p.flowBias; u.scatter.value = p.scatter; u.maxForce.value = p.maxForce;
  u.turbulenceScale.value = p.turbulenceScale; u.turbulenceSpeed.value = p.turbulenceSpeed;
  u.stiffness.value = spring.stiffness; u.damping.value = spring.damping; u.maxOffset.value = spring.maxOffset;
  u.breath.value = idle.breathing; u.drift.value = idle.drift; u.flow.value = idle.flow;
  u.idleSpeed.value = idle.speed; u.breathFrequency.value = idle.frequency;
  u.contraction.value = listening.contraction; u.coherence.value = listening.coherence;
  u.listeningBreath.value = listening.breath; u.inputResponse.value = listening.response; u.listeningGlow.value = listening.glow;
  u.focusContraction.value = focus.contraction; u.focusCoherence.value = focus.coherence; u.focusGlow.value = focus.glow;
  u.rotation.value = thinking.rotation; u.thoughtTurbulence.value = thinking.turbulence; u.thoughtTravel.value = thinking.travel;
  u.audioForce.value = speaking.radial; u.audioTurbulence.value = speaking.turbulence;
  u.audioFlow.value = speaking.flow; u.audioAccent.value = speaking.accent; u.spectrumStrength.value = speaking.spectrum;
  u.size.value = geometry.size;
  u.ambient.value = lighting.ambient; u.key.value = lighting.key; u.fill.value = lighting.fill; u.wrap.value = lighting.wrap;
}

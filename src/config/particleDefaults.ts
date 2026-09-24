// Reference baseline from the task/Cortiz force model.
export const referenceDefaults = {
  count: 75_000, size: 0.020,
  mouseRadius: 2.15, mouseStrength: 4.9, mouseScatter: 1,
  spring: 40, damping: 20,
  radius: 0.05, influence: 0.40, falloff: 2.5, depth: 2,
  follow: 12, movement: 121, flowBias: 1.3,
  pusherSpring: 27, pusherDamping: 22.1, maxOffset: 13.8,
  turbulence: 70, turbulenceScale: 2.2, turbulenceSpeed: 1.85,
} as const;

export const particleDefaults = {
  geometry: { radius: 1.35, size: 0.0165 },
  // Drift and flow are target displacements, so spring stiffness does not erase them.
  // Idle is asleep but alive: visible breathing, slow circulation, only slight asymmetry.
  idle: { breathing: 0.085, frequency: 1.5, drift: 0.17, flow: 0.2, speed: 0.4 },
  pusher: {
    radius: 0.05, influence: 0.52, falloff: 2.5, depth: 3.4,
    follow: 12, movement: 40, radial: 4.9, flowBias: 1.3,
    scatter: 0.3, maxSpeed: 8, maxForce: 90,
    turbulence: 14, turbulenceScale: 2.2, turbulenceSpeed: 1.85,
  },
  spring: { stiffness: 30, damping: 7.4, maxOffset: 1.1 },
  // Listening is inward: the body gathers, calms and brightens slightly; the voice draws it in.
  listening: { contraction: 0.04, coherence: 0.6, breath: 0.45, response: 0.03, glow: 0.05 },
  // Acoustic focus: a brief extra contraction and stillness when the user stresses a word.
  focus: { contraction: 0.045, coherence: 0.5, glow: 0.07 },
  thinking: { turbulence: 0.52, rotation: 0.72, travel: 0.12 },
  // Most speech motion is local displacement; keep whole-body inflation restrained.
  speaking: { radial: 0.45, turbulence: 0.055, flow: 0.20, accent: 0.20, spectrum: 1.2 },
  lighting: { ambient: 0.16, key: 1.25, fill: 0.28, wrap: 0.45 },
  bloom: { strength: 0.20, radius: 0.38, threshold: 0.85 },
};
export type ParticleConfig = typeof particleDefaults;

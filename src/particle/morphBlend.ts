const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const x = clamp01((value - edge0) / (edge1 - edge0));
  return x * x * (3 - 2 * x);
};

/**
 * How assistant speech acts on the body while a Visual Action is formed (`level` is the controller's
 * eased morph weight). Speaking physics is destructive to a formed image — radial tufts, local lift
 * and turbulence scatter the glyph or portrait — so it fades out early in the morph. Once the image
 * is legible a small, bounded audio-reactive shimmer takes over, so the visual still breathes with
 * the voice instead of freezing.
 */
export function morphSpeechBlend(level: number) {
  const m = clamp01(level);
  return {
    /** Gain on the sphere's speaking forces (1 on the sphere, 0 once the visual is mostly formed). */
    speech: 1 - smoothstep(0.08, 0.6, m),
    /** Weight of the formed-state shimmer (0 on the sphere, 1 once the visual is legible). */
    shimmer: smoothstep(0.5, 0.95, m),
  };
}

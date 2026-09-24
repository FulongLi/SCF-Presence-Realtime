export function createSphere(count: number, radius: number) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  let seed = 0x5cf2026;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // Every prefix stays volumetric when the active particle count changes.
  for (let i = 0; i < count; i++) {
    const y = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const r = radius * Math.cbrt(random());
    const ring = Math.sqrt(1 - y * y);
    positions.set([Math.cos(angle) * ring * r, y * r, Math.sin(angle) * ring * r], i * 3);
    const sy = random() * 2 - 1;
    const sa = random() * Math.PI * 2;
    const sr = Math.sqrt(1 - sy * sy);
    seeds.set([Math.cos(sa) * sr, sy, Math.sin(sa) * sr], i * 3);
  }
  return { positions, seeds };
}

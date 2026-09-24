import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveQuality, qualityRange, qualityTiers } from "../src/particle/quality";
import { createSphere } from "../src/particle/sphere/createSphere";

const run = (quality: AdaptiveQuality, dt: number, seconds: number) => {
  let changes = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) if (quality.sample(dt)) changes++;
  return changes;
};

test("tiers extend to high-end desktops while phones stay conservative", () => {
  assert.deepEqual(qualityTiers.map(tier => tier.count), [6_000, 12_000, 20_000, 35_000, 50_000]);
  assert.deepEqual(qualityRange(true, 16, 16), { initial: 0, max: 1 });
  assert.deepEqual(qualityRange(false, 4, 8), { initial: 0, max: 2 });
  assert.deepEqual(qualityRange(false, 8, 8), { initial: 1, max: 3 });
  assert.deepEqual(qualityRange(false, 16, 16), { initial: 2, max: 4 });
});

test("sustained slowness steps down; isolated stalls do not", () => {
  const slow = new AdaptiveQuality(2, 4);
  run(slow, 1 / 30, 11);
  assert.equal(slow.tier, 1);
  const stalls = new AdaptiveQuality(2, 2);
  for (let i = 0; i < 700; i++) stalls.sample(i % 100 === 0 ? 1 : 1 / 60);
  assert.equal(stalls.tier, 2);
});

test("sustained smoothness steps up slowly, one tier at a time, up to the ceiling", () => {
  const quality = new AdaptiveQuality(2, 4);
  run(quality, 1 / 60, 20);
  assert.equal(quality.tier, 2, "upgrading takes much longer than downgrading");
  run(quality, 1 / 60, 10);
  assert.equal(quality.tier, 3);
  run(quality, 1 / 60, 120);
  assert.equal(quality.tier, 4);
  assert.equal(quality.ceiling, 4);
});

test("a tier that proves slow right after an upgrade becomes the ceiling (no oscillation)", () => {
  const quality = new AdaptiveQuality(2, 4);
  run(quality, 1 / 60, 30);
  assert.equal(quality.tier, 3);
  run(quality, 1 / 30, 12);
  assert.equal(quality.tier, 2);
  assert.equal(quality.ceiling, 2);
  const changes = run(quality, 1 / 60, 300);
  assert.equal(changes, 0);
  assert.equal(quality.tier, 2);
});

test("frames with drops never count as good, even when the mean is fine", () => {
  const quality = new AdaptiveQuality(1, 4);
  for (let i = 0; i < 60 * 120; i++) quality.sample(i % 20 === 0 ? 0.034 : 0.0155);
  assert.equal(quality.tier, 1);
});

test("sphere samples are deterministic and every quality prefix covers the volume", () => {
  const full = createSphere(qualityTiers[4].count, 1.35);
  assert.deepEqual(full.positions.slice(0, 300), createSphere(100, 1.35).positions);
  for (const tier of qualityTiers) {
    let sumX = 0, sumY = 0, sumZ = 0, meanRadius = 0;
    const n = Math.min(tier.count, 4000);
    for (let i = 0; i < n; i++) {
      const x = full.positions[i * 3], y = full.positions[i * 3 + 1], z = full.positions[i * 3 + 2];
      const radius = Math.hypot(x, y, z);
      assert.ok(radius <= 1.350001);
      meanRadius += radius; sumX += x; sumY += y; sumZ += z;
    }
    assert.ok(Math.abs(sumX / n) < 0.06 && Math.abs(sumY / n) < 0.06 && Math.abs(sumZ / n) < 0.06);
    assert.ok(Math.abs(meanRadius / n - 1.35 * 0.75) < 0.05, "uniform volume: mean radius is 3/4 R");
  }
  for (let i = 0; i < 1000; i++) assert.ok(Math.abs(Math.hypot(...full.seeds.slice(i * 3, i * 3 + 3)) - 1) < 1e-6);
});

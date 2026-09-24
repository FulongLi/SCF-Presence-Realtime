import test from "node:test";
import assert from "node:assert/strict";
import { SpectrumEnvelope } from "../src/audio/spectrum";

function tone(frequency: number) {
  const bins = new Float32Array(1024).fill(-Infinity);
  bins[Math.round(frequency * 2048 / 48000)] = -26;
  return bins;
}
test("equal loudness at different frequencies moves different bands", () => {
  const low = new SpectrumEnvelope(48000, 2048);
  const high = new SpectrumEnvelope(48000, 2048);
  for (let i = 0; i < 60; i++) {
    low.sample(tone(160), 0.05, 1 / 60);
    high.sample(tone(4000), 0.05, 1 / 60);
  }
  assert.ok(low.bands[2] > 0.5); assert.equal(low.bands[11], 0);
  assert.ok(high.bands[11] > 0.5); assert.equal(high.bands[2], 0);
});
test("spectral attack is quick and release lingers without a perpetual noise floor", () => {
  const envelope = new SpectrumEnvelope(48000, 2048);
  const bins = tone(450);
  envelope.sample(bins, 0.05, 0.05);
  const attack = envelope.bands[5];
  assert.ok(attack > 0.5);
  envelope.sample(bins, 0, 0.05);
  assert.ok(envelope.bands[5] > attack * 0.6);
  for (let i = 0; i < 120; i++) envelope.sample(bins, 0, 1 / 60);
  assert.ok(envelope.bands.every(value => value < 0.00001));
});
test("band envelopes are stable across frame rates, invalid bins and lower sample rates", () => {
  const a = new SpectrumEnvelope(48000, 2048), b = new SpectrumEnvelope(48000, 2048);
  for (let i = 0; i < 30; i++) a.sample(tone(450), 0.05, 1 / 30);
  for (let i = 0; i < 120; i++) b.sample(tone(450), 0.05, 1 / 120);
  assert.ok(Math.abs(a.bands[5] - b.bands[5]) < 1e-6);
  const lowRate = new SpectrumEnvelope(16000, 2048);
  const bands = lowRate.sample(new Float32Array(1024).fill(NaN), Infinity, 0.1);
  assert.ok(bands.every(value => value === 0));
  lowRate.sample(new Float32Array(1024).fill(-20), 0.1, 0.1);
  assert.equal(bands[14], 0); assert.equal(bands[15], 0);
});

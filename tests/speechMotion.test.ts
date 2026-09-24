import test from "node:test";
import assert from "node:assert/strict";
import { morphSpeechBlend } from "../src/particle/morphBlend";
import { SpeechMotion } from "../src/particle/speechMotion";

function advance(motion: SpeechMotion, input: number, seconds: number, fps = 60) {
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) motion.sample(input, 1 / fps);
  return motion.value;
}

test("silence cannot generate its own speech gestures", () => {
  const motion = new SpeechMotion();
  advance(motion, 0, 10);
  const { body, accent, articulation, follow, phase } = motion.value;
  assert.deepEqual([body, accent, articulation, follow, phase], [0, 0, 0, 0, 0]);
});

test("a sustained loud sound settles instead of retriggering accents", () => {
  const motion = new SpeechMotion();
  advance(motion, 0.8, 0.1);
  assert.ok(motion.value.accent > 0.4);
  advance(motion, 0.8, 3);
  assert.ok(motion.value.accent < 0.001);
  assert.ok(motion.value.articulation < 0.001);
  assert.ok(motion.value.body > 0.79);
});

test("emphasis is relative to the recent voice level, including quiet speech", () => {
  for (const base of [0.06, 0.3]) {
    const motion = new SpeechMotion();
    advance(motion, base, 2);
    assert.ok(motion.value.accent < 0.001);
    advance(motion, base * 2.5, 0.1);
    assert.ok(motion.value.accent > 0.2);
  }
});

test("accents change region and the follower responds after the lead", () => {
  const motion = new SpeechMotion();
  motion.sample(0.7, 1 / 60);
  assert.ok(motion.value.accent > motion.value.follow * 5);
  advance(motion, 0.7, 0.2);
  const first = motion.value.directionX;
  assert.ok(motion.value.follow > 0.1);
  advance(motion, 0, 1);
  advance(motion, 0.7, 0.2);
  assert.ok(Math.abs(motion.value.directionX - first) > 0.1);
});

test("short pauses retain motion, long silence settles, and timing is frame-rate independent", () => {
  const final = [];
  for (const fps of [30, 60, 120]) {
    const motion = new SpeechMotion();
    advance(motion, 0.5, 1, fps);
    advance(motion, 0, 0.2, fps);
    assert.ok(motion.value.body > 0.2);
    final.push(motion.value.body);
    advance(motion, 0, 3, fps);
    assert.ok(motion.value.body < 0.001 && motion.value.follow < 0.001);
  }
  assert.ok(Math.max(...final) - Math.min(...final) < 0.001);
});

test("invalid input and long frames cannot produce unbounded or non-finite envelopes", () => {
  const motion = new SpeechMotion();
  for (const input of [1, NaN, Infinity, -9, 500, 0]) {
    for (const dt of [0, -1, NaN, Infinity, 100, 1 / 60]) {
      const value = motion.sample(input, dt);
      for (const key of ["body", "accent", "follow", "articulation"] as const) {
        assert.ok(Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1);
      }
      assert.ok(Object.values(value).every(Number.isFinite));
    }
  }
});

test("a formed Visual Action stays legible while speech continues, and still shimmers", () => {
  const sphere = morphSpeechBlend(0), half = morphSpeechBlend(0.5), formed = morphSpeechBlend(1);
  assert.deepEqual(sphere, { speech: 1, shimmer: 0 }, "the sphere keeps full speaking physics");
  assert.ok(half.speech < 0.25, "destructive speaking forces are mostly gone by mid-morph");
  assert.equal(formed.speech, 0, "no tufts, lift or turbulence scatter a formed image");
  assert.equal(formed.shimmer, 1, "a small audio-reactive shimmer replaces them: not frozen");
  let previous = morphSpeechBlend(0);
  for (let level = 0.05; level <= 1.0001; level += 0.05) {
    const next = morphSpeechBlend(level);
    assert.ok(next.speech <= previous.speech && next.shimmer >= previous.shimmer, "monotonic, no pumping");
    previous = next;
  }
  assert.deepEqual(morphSpeechBlend(NaN), { speech: 1, shimmer: 0 });
});

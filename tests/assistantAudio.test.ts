import test from "node:test";
import assert from "node:assert/strict";
import { AssistantAudio, type AssistantAudioEnvironment } from "../src/audio/assistant";
import { SPECTRUM_BANDS } from "../src/audio/spectrum";
import { PresenceEngine } from "../src/presence/PresenceEngine";

/** A fake Web Audio graph whose analyser reports a loud 450 Hz voice. */
function environment({ autoplay = true, contextState = "running" } = {}) {
  const frames: FrameRequestCallback[] = [];
  const connections: string[] = [];
  const analyser = {
    fftSize: 2048, smoothingTimeConstant: 0,
    getFloatTimeDomainData(samples: Float32Array) { for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin(i * 0.06); },
    getFloatFrequencyData(bins: Float32Array) { bins.fill(-Infinity); bins[Math.round(450 * 2048 / 48000)] = -20; },
    connect: (target: unknown) => connections.push(`analyser→${target === "destination" ? "speakers" : "node"}`),
    disconnect: () => connections.push("analyser×"),
  };
  const context = {
    state: contextState, sampleRate: 48000, destination: "destination",
    createAnalyser: () => analyser,
    createMediaStreamSource: () => ({ connect: () => connections.push("source→analyser"), disconnect: () => connections.push("source×") }),
    resume: async () => { context.state = "running"; },
    close: async () => {},
  };
  const element = {
    srcObject: null as unknown, paused: true,
    play: () => autoplay ? (element.paused = false, Promise.resolve()) : Promise.reject(new Error("NotAllowedError")),
    pause: () => { element.paused = true; },
  };
  const env: AssistantAudioEnvironment = {
    element: () => element as unknown as HTMLAudioElement,
    context: () => context as unknown as AudioContext,
    frame: callback => { frames.push(callback); return frames.length; },
    cancelFrame: () => {},
  };
  const tick = (times: number) => { for (let i = 0; i < times; i++) frames.shift()?.(i * 16.7 + 16.7); };
  return { env, element, context, connections, tick, frames };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("the real remote voice plays once and drives speaking amplitude and spectrum", async () => {
  const fake = environment();
  const engine = new PresenceEngine();
  const states: string[] = [];
  const audio = new AssistantAudio(engine, state => states.push(state), fake.env);
  const stream = {} as MediaStream;
  audio.attach(stream);
  await settle();
  assert.equal(fake.element.srcObject, stream, "playback uses the remote stream itself");
  assert.deepEqual(states, ["playing"]);
  assert.ok(!fake.connections.includes("analyser→speakers"), "the analysis graph never plays a second copy");
  fake.tick(30);
  const signal = engine.sample(1 / 60, 30 * 0.0167);
  assert.equal(signal.mode, "speaking");
  assert.ok(signal.assistantAmplitude > 0.05);
  assert.equal(signal.assistantBands.length, SPECTRUM_BANDS);
  assert.ok(signal.assistantBands[5] > 0.3, "the 420–600 Hz band carries the voice");
  audio.detach();
  assert.equal(fake.element.srcObject, null);
  assert.equal(fake.frames.length, 1, "the pending frame is from the old generation");
  fake.tick(1);
  assert.equal(fake.frames.length, 0, "analysis stops with the session");
});

test("autoplay-blocked playback is reported and retried on the next gesture", async () => {
  const fake = environment({ autoplay: false, contextState: "suspended" });
  const states: string[] = [];
  const audio = new AssistantAudio(new PresenceEngine(), state => states.push(state), fake.env);
  audio.attach({} as MediaStream);
  await settle();
  assert.deepEqual(states, ["blocked"]);
  fake.element.play = () => { fake.element.paused = false; return Promise.resolve(); };
  audio.prime();
  await settle();
  assert.deepEqual(states, ["blocked", "playing"]);
});

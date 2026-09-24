import test from "node:test";
import assert from "node:assert/strict";
import { PresenceController } from "../src/presence/controller";
import type { RealtimeEnvironment } from "../src/realtime/client";

// The controller's browser-facing pieces (getUserMedia, AudioContext) are exercised by the smoke test;
// here we check its React-facing contract with a transport that never connects.
const environment: RealtimeEnvironment = {
  fetchToken: () => new Promise(() => {}),
  createPeer: () => { throw new Error("not used"); },
  exchangeSdp: () => new Promise(() => {}),
  now: () => 0,
  setTimer: () => 0,
  clearTimer: () => {},
};

test("construction is side-effect free and exposes a stable server snapshot", () => {
  const controller = new PresenceController(environment);
  assert.deepEqual(controller.getServerSnapshot(), { mic: "checking", connection: "disconnected", error: null, needsGesture: false, playback: "idle" });
  assert.equal(controller.getSnapshot(), controller.getSnapshot(), "snapshots are referentially stable between updates");
});

test("the body is wired to the session: engine reads Realtime hints and the visual controller", () => {
  const controller = new PresenceController(environment);
  const signal = controller.engine.sample(1 / 60, 1);
  assert.equal(signal.mode, "idle");
  assert.deepEqual(controller.client.hints(1), { live: false, userSpeaking: false, awaitingResponse: false, toolActive: false });
  assert.equal(controller.visual.phase, "sphere");
});

test("stop() leaves no session behind and notifies subscribers once per change", () => {
  const controller = new PresenceController(environment);
  let notified = 0;
  const unsubscribe = controller.subscribe(() => notified++);
  controller.stop();
  assert.equal(controller.client.connection, "disconnected");
  assert.equal(controller.getSnapshot().mic, "checking");
  controller.stop();
  unsubscribe();
  assert.equal(notified, 0, "no change, no notification");
});

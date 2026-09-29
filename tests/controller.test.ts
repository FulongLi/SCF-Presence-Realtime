import test from "node:test";
import assert from "node:assert/strict";
import { PresenceController } from "../src/presence/controller";
import type { LiveEnvironment } from "../src/live/client";
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
const live: LiveEnvironment = {
  createPeer: () => { throw new Error("not used"); },
  createSession: () => new Promise(() => {}),
  now: () => 0,
  setTimer: () => 0,
  clearTimer: () => {},
};
const environments = { realtime: environment, live };

test("construction is side-effect free and exposes a stable server snapshot", () => {
  const controller = new PresenceController(environments);
  assert.deepEqual(controller.getServerSnapshot(), { mic: "checking", connection: "disconnected", error: null, needsGesture: false, playback: "idle" });
  assert.equal(controller.getSnapshot(), controller.getSnapshot(), "snapshots are referentially stable between updates");
});

test("the body is wired to the session: engine reads the voice backend's hints and the visual controller", () => {
  const controller = new PresenceController(environments);
  const signal = controller.engine.sample(1 / 60, 1);
  assert.equal(signal.mode, "idle");
  assert.deepEqual(controller.client.hints(1), { live: false, userSpeaking: false, awaitingResponse: false, toolActive: false });
  assert.equal(controller.visual.phase, "sphere");
});

test("stop() leaves no session behind and notifies subscribers once per change", () => {
  const controller = new PresenceController(environments);
  let notified = 0;
  const unsubscribe = controller.subscribe(() => notified++);
  controller.stop();
  assert.equal(controller.client.connection, "disconnected");
  assert.equal(controller.getSnapshot().mic, "checking");
  controller.stop();
  unsubscribe();
  assert.equal(notified, 0, "no change, no notification");
});

test("Aion is wired in: the body tool changes the persistent body and releases a visual on show", async () => {
  const controller = new PresenceController(environments);
  assert.equal(controller.aion.currentBody, "sphere");
  const result = await controller.executor.execute("set_body_form", JSON.stringify({ form: "figure" }));
  assert.deepEqual(result.result, { ok: true, status: "body-changed", shown: "Particle Figure" });
  assert.equal(controller.aion.currentBody, "figure");
  assert.equal(controller.setBody("figure"), false, "already the figure");
  assert.equal(controller.visual.phase, "sphere", "no temporary visual was started");
});

test("the first greeting is not spoken without a session, and a failed attempt does not use it up", () => {
  const controller = new PresenceController(environments);
  assert.equal(controller.aion.greeting.status, "waiting");
  assert.equal(controller.greet(), false, "no connected session: nothing is said");
  assert.equal(controller.aion.greeting.status, "waiting", "the automatic greeting can still happen");
  assert.equal(controller.aion.currentState, "idle", "no greeting gesture without a greeting");
});

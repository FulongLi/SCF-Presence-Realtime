import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Aion } from "../src/aion";
import { AION_BODIES, AionBody, bodyTransition, PERSISTENT_BODIES, resolveBodyForm } from "../src/aion/body";
import { GreetingGate, type GreetingInputs } from "../src/aion/greeting";
import { greetingLine, identityGuidance, onboardingGuidance, onboardingLine, ONBOARDING_EXAMPLES, supportedExamples } from "../src/aion/guidance";
import { AION_IDENTITY } from "../src/aion/identity";
import { AION_STATES, AionStateMachine, GESTURE_SECONDS, sanitizeState } from "../src/aion/state";
import { createFigureLayout, FIGURE_KINDS, figurePoint, packAnchors, unpackAnchors } from "../src/aion/figure/layout";
import { FigureAnimator, gestureTarget, NEUTRAL_POSE, solvePose } from "../src/aion/figure/pose";
import { ANCHOR, ANCHOR_COUNT, ANCHORS, FIGURE_SCALE, PROPORTIONS } from "../src/aion/figure/skeleton";
import { LIVE_BACKEND_INSTRUCTIONS, LIVE_VOICE_INSTRUCTIONS } from "../src/live/instructions";
import { PRESENCE_INSTRUCTIONS } from "../src/realtime/instructions";
import { createSignal } from "../src/presence/signal";
import { VISUAL_TOOL_NAMES, visualTools } from "../src/voice/tools/definitions";
import { toolCallToVisualAction, ToolExecutor } from "../src/voice/tools/executor";
import { VisualActionController } from "../src/visual-actions/controller";
import type { MorphTarget } from "../src/visual-actions/types";

// ── Identity ─────────────────────────────────────────────────────────────────────────────────────────

test("Aion's identity is one canonical, frozen manifest", () => {
  assert.deepEqual({ ...AION_IDENTITY }, {
    name: "Aion", product: "Intelligent Presence", creatorCompany: "Spirit Connect", leadCreator: "Fulong", nature: "interactive AI presence",
  });
  assert.ok(Object.isFrozen(AION_IDENTITY));
});

test("identity strings live only in the manifest; everything else reads them from it", () => {
  // The promo film (src/promo) is a scripted piece with its own dialogue, not Aion's live identity.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "promo") walk(path); } else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  const canonical = join("src", "aion", "identity.ts");
  for (const literal of ["Fulong", "Intelligent Presence", "\"Aion\""]) {
    const holders = files.filter(file => readFileSync(file, "utf8").includes(literal)).map(file => file.slice(file.indexOf("src")));
    assert.deepEqual(holders, [canonical], `${literal} appears only in ${canonical}`);
  }
});

test("both backends' prompts carry the identity facts, language following and honest self-description", () => {
  const facts = [AION_IDENTITY.name, AION_IDENTITY.creatorCompany, AION_IDENTITY.leadCreator, AION_IDENTITY.product];
  for (const prompt of [PRESENCE_INSTRUCTIONS, LIVE_VOICE_INSTRUCTIONS]) {
    for (const fact of facts) assert.ok(prompt.includes(fact), fact);
    assert.match(prompt, /Start in English/);
    assert.match(prompt, /switch when they switch/);
    assert.match(prompt, /do not claim consciousness/);
    assert.match(prompt, /我是 Aion/, "Chinese self-description keeps the names");
    assert.ok(prompt.includes(onboardingGuidance()), "onboarding guidance");
  }
  assert.ok(LIVE_BACKEND_INSTRUCTIONS.includes(AION_IDENTITY.name) && LIVE_BACKEND_INSTRUCTIONS.includes(AION_IDENTITY.creatorCompany));
  assert.ok(identityGuidance({ ...AION_IDENTITY, name: "Test" }).startsWith("You are Test"), "prompt text is generated from the manifest");
});

test("the greeting is short, from the manifest, and not a feature list", () => {
  assert.equal(greetingLine(), "Hi, I'm Aion. You can just talk to me naturally. If you'd like, ask me to show you something.");
  assert.ok(greetingLine().split(/[.!?]/).filter(Boolean).length <= 3);
});

test("onboarding only suggests what this build can actually do", () => {
  const supported = supportedExamples();
  assert.equal(supported.length, ONBOARDING_EXAMPLES.length, "every built-in example is supported");
  for (const example of supported) {
    assert.ok((VISUAL_TOOL_NAMES as readonly string[]).includes(example.tool), example.tool);
    if (example.tool === "set_body_form") assert.equal(resolveBodyForm(example.args.form), "figure");
    else assert.ok(toolCallToVisualAction(example.tool, example.args), `${example.say} maps to a valid visual action`);
  }
  assert.equal(supportedExamples([{ say: "a hologram", tool: "show_hologram" as never, args: {} }]).length, 0, "an unknown tool is never offered");
  assert.equal(supportedExamples([{ say: "Andromeda", tool: "show_form", args: { form: "andromeda galaxy" } }]).length, 0, "an unknown form is never offered");
  assert.match(onboardingLine(), /Orion/);
  assert.match(onboardingGuidance(), /怎么玩/);
});

// ── Greeting ─────────────────────────────────────────────────────────────────────────────────────────

const ready: GreetingInputs = { micReady: true, connected: true, bodyReady: true, userActive: false, conversationActive: false };

test("the greeting fires once, only after microphone, connection and body are all ready and quiet", () => {
  const gate = new GreetingGate({ settleMs: 900 });
  for (const missing of ["micReady", "connected", "bodyReady"] as const) {
    assert.equal(gate.update({ ...ready, [missing]: false }, 5000), false, `not without ${missing}`);
  }
  assert.equal(gate.status, "waiting");
  assert.equal(gate.update(ready, 10_000), false, "settles first");
  assert.equal(gate.update(ready, 10_500), false);
  assert.equal(gate.update(ready, 10_900), true, "then greets");
  assert.equal(gate.status, "sent");
  for (let t = 11_000; t < 20_000; t += 150) assert.equal(gate.update(ready, t), false, "never twice");
});

test("losing readiness before the greeting restarts the settle", () => {
  const gate = new GreetingGate({ settleMs: 900 });
  gate.update(ready, 0);
  gate.update({ ...ready, connected: false }, 600);
  assert.equal(gate.update(ready, 1000), false);
  assert.equal(gate.update(ready, 1800), false);
  assert.equal(gate.update(ready, 1900), true);
});

test("the user speaking first suppresses the greeting for good", () => {
  const gate = new GreetingGate({ settleMs: 900 });
  gate.update(ready, 0);
  assert.equal(gate.update({ ...ready, userActive: true }, 400), false);
  assert.equal(gate.status, "suppressed");
  assert.equal(gate.update(ready, 5000), false);
  const busy = new GreetingGate();
  busy.update({ ...ready, conversationActive: true }, 0);
  assert.equal(busy.status, "suppressed", "an assistant already talking also suppresses it");
  const early = new GreetingGate({ settleMs: 900 });
  early.update({ ...ready, connected: false, userActive: true }, 0);
  assert.equal(early.status, "waiting", "noise before any session exists does not count");
});

test("reconnects never produce a second greeting", () => {
  const gate = new GreetingGate({ settleMs: 100 });
  let greetings = 0;
  let t = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let i = 0; i < 10; i++) { t += 50; if (gate.update({ ...ready, connected: i > 2 }, t)) greetings++; }
  }
  assert.equal(greetings, 1);
});

// ── State ────────────────────────────────────────────────────────────────────────────────────────────

test("conversational state maps to Aion's state: idle → listening → thinking (with a nod) → speaking → idle", () => {
  const machine = new AionStateMachine();
  const at = (mode: string, now: number, presenting = false) => machine.update({ mode, presenting }, now);
  assert.equal(at("idle", 0), "idle");
  assert.equal(at("listening", 1), "listening");
  assert.equal(at("thinking", 3), "acknowledging", "the user's turn ending gets one small nod");
  assert.equal(at("thinking", 3 + GESTURE_SECONDS.acknowledging + 0.01), "thinking");
  assert.equal(at("speaking", 5), "speaking");
  assert.equal(at("idle", 8), "idle");
  assert.equal(at("speaking", 9, true), "presenting", "a visual tool is presenting");
});

test("gestures are one-shot and restrained; invalid states fall back to idle", () => {
  const machine = new AionStateMachine();
  machine.trigger("greeting");
  assert.equal(machine.update({ mode: "speaking", presenting: false }, 0), "greeting");
  assert.equal(machine.update({ mode: "speaking", presenting: true }, 1), "greeting", "the greeting completes");
  assert.equal(machine.update({ mode: "speaking", presenting: false }, GESTURE_SECONDS.greeting + 0.01), "speaking");
  machine.trigger("curious");
  assert.equal(machine.update({ mode: "idle", presenting: false }, 10), "curious");
  assert.equal(machine.update({ mode: "idle", presenting: false }, 10 + GESTURE_SECONDS.curious + 0.01), "idle");
  assert.equal(machine.update({ mode: "dancing", presenting: false }, 20), "idle");
  assert.equal(sanitizeState("excited"), "idle");
  assert.equal(sanitizeState(undefined), "idle");
  machine.force("nonsense");
  assert.equal(machine.update({ mode: "speaking", presenting: false }, 30), "idle", "a forced invalid state is idle");
  machine.force(null);
  assert.equal(machine.update({ mode: "speaking", presenting: false }, 31), "speaking");
  assert.ok(AION_STATES.every(state => sanitizeState(state) === state));
});

// ── Body ─────────────────────────────────────────────────────────────────────────────────────────────

test("the sphere remains the default body and the figure can be selected by id or plain name", () => {
  assert.deepEqual([...AION_BODIES], ["sphere", "figure"]);
  assert.deepEqual(PERSISTENT_BODIES.map(body => body.id), [...AION_BODIES]);
  const body = new AionBody();
  assert.equal(body.form, "sphere");
  for (const [name, id] of [["figure", "figure"], ["a human form", "figure"], ["Humanoid", "figure"], ["人形", "figure"],
    ["the sphere", "sphere"], ["球体", "sphere"], ["Sphere.", "sphere"]] as const) assert.equal(resolveBodyForm(name), id, name);
  for (const name of ["dragon", "", "<script>", 42, "a".repeat(80)]) assert.equal(resolveBodyForm(name), null, String(name));
  assert.equal(body.set("figure"), true);
  assert.equal(body.set("figure"), false, "already the figure");
  assert.equal(body.set("dragon" as never), false);
  let level = 0;
  for (let t = 0; t < bodyTransition.seconds + 0.2; t += 1 / 60) level = body.sample(1 / 60);
  assert.equal(level, 1);
  assert.equal(body.transitioning, false);
  body.set("sphere");
  for (let t = 0; t < bodyTransition.seconds + 0.2; t += 1 / 60) level = body.sample(1 / 60);
  assert.equal(level, 0);
});

test("set_body_form is its own tool, separate from show_form, and changes only the persistent body", async () => {
  const tool = visualTools.find(item => item.name === "set_body_form")!;
  assert.deepEqual(tool.parameters.properties.form.enum, [...AION_BODIES]);
  assert.deepEqual(tool.parameters.required, ["form"]);
  assert.equal(toolCallToVisualAction("set_body_form", { form: "figure" }), null, "not a temporary visual");
  const changes: string[] = [];
  let form = "sphere";
  const visual = new VisualActionController(async () => { throw new Error("unused"); });
  const executor = new ToolExecutor(visual, undefined, { setBody: next => { changes.push(next); const changed = next !== form; form = next; return changed; } });
  assert.deepEqual((await executor.execute("set_body_form", "{\"form\":\"figure\"}")).result, { ok: true, status: "body-changed", shown: "Particle Figure" });
  assert.deepEqual((await executor.execute("set_body_form", "{\"form\":\"human\"}")).result, { ok: true, status: "unchanged", shown: "Particle Figure" });
  assert.deepEqual((await executor.execute("set_body_form", "{\"form\":\"sphere\"}")).result, { ok: true, status: "body-changed", shown: "Sphere" });
  for (const bad of ["{\"form\":\"dragon\"}", "{}", "{\"form\":\"figure\",\"x\":1}", "[1]"]) {
    assert.deepEqual((await executor.execute("set_body_form", bad)).result, { ok: false, status: "invalid-arguments" }, bad);
  }
  assert.deepEqual(changes, ["figure", "figure", "sphere"]);
  assert.equal(visual.phase, "sphere", "no temporary visual was started");
  const bodiless = new ToolExecutor(visual);
  assert.deepEqual((await bodiless.execute("set_body_form", "{\"form\":\"figure\"}")).result, { ok: false, status: "unresolved" });
});

/** A runtime-like frame loop over Aion and the visual controller: the persistent body under the visual. */
function stage(presentingTarget: MorphTarget) {
  const signal = createSignal();
  const visual = new VisualActionController(async () => presentingTarget);
  const aion = new Aion({ signal: () => signal, presenting: () => visual.presenting });
  let now = 0;
  const run = (seconds: number) => {
    let frame = aion.sample(0, now), morph = visual.level;
    for (let i = 0; i < Math.round(seconds * 60); i++) { now += 1 / 60; morph = visual.sample(1 / 60); frame = aion.sample(1 / 60, now); }
    return { body: frame.level, morph, state: aion.currentState };
  };
  return { aion, visual, run };
}
const orion: MorphTarget = { visual: { kind: "points", style: "celestial", layout: { points: [{ x: 0, y: 0, radius: 0.05, weight: 1, tone: 1 }], strokes: [], dust: 0.2 } }, hold: 3, label: "Orion" };

test("figure → temporary visual → figure: the visual returns to the persistent body, not the sphere", async () => {
  const { aion, visual, run } = stage(orion);
  aion.setBody("figure");
  assert.equal(run(bodyTransition.seconds + 0.5).body, 1);
  await visual.submit({ type: "form", form: "astronomy.orion" });
  const presenting = run(1);
  assert.equal(presenting.state, "presenting");
  assert.equal(presenting.body, 1, "the figure is still the rest the visual forms from");
  assert.ok(run(3).morph > 0.99, "Orion formed");
  const after = run(5);
  assert.equal(after.morph, 0, "the visual is gone");
  assert.equal(visual.phase, "sphere", "…back at rest");
  assert.equal(after.body, 1, "and the rest is still the figure");
  assert.equal(aion.currentBody, "figure", "the persistent body was remembered");
  assert.notEqual(after.state, "presenting");
});

test("sphere → temporary visual → sphere is unchanged", async () => {
  const { aion, visual, run } = stage(orion);
  await visual.submit({ type: "form", form: "astronomy.orion" });
  assert.ok(run(4).morph > 0.99);
  const after = run(5);
  assert.equal(after.morph, 0);
  assert.equal(after.body, 0);
  assert.equal(aion.currentBody, "sphere");
});

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────────────

test("the skeleton has every required anchor", () => {
  const required = ["head", "neck", "shoulderLeft", "shoulderRight", "elbowLeft", "elbowRight", "handLeft", "handRight",
    "spine", "hipLeft", "hipRight", "kneeLeft", "kneeRight", "footLeft", "footRight"];
  assert.deepEqual([...ANCHORS].sort(), required.sort());
  assert.ok(ANCHOR_COUNT <= 16, "anchor indices fit the 4-bit packing");
});

const finite = (values: ArrayLike<number>) => Array.from(values).every(Number.isFinite);

test("the neutral pose is a standing figure in normalized bounds, symmetric, with preserved limb lengths", () => {
  const p = solvePose(NEUTRAL_POSE);
  assert.ok(finite(p));
  const at = (name: keyof typeof ANCHOR) => [p[ANCHOR[name] * 3], p[ANCHOR[name] * 3 + 1], p[ANCHOR[name] * 3 + 2]];
  for (const name of ANCHORS) for (const value of at(name)) assert.ok(Math.abs(value) <= 1, `${name} within bounds`);
  assert.ok(at("head")[1] + PROPORTIONS.headRadius < 1 && at("footLeft")[1] > -1);
  assert.ok(at("head")[1] > at("neck")[1] && at("neck")[1] > at("spine")[1] && at("spine")[1] > at("kneeLeft")[1] && at("kneeLeft")[1] > at("footLeft")[1]);
  assert.ok(at("shoulderLeft")[0] > 0 && at("shoulderRight")[0] < 0, "the figure faces the viewer: its left is on the viewer's right");
  for (const [a, b] of [["shoulderLeft", "shoulderRight"], ["handLeft", "handRight"], ["footLeft", "footRight"]] as const) {
    assert.ok(Math.abs(at(a)[0] + at(b)[0]) < 1e-6 && Math.abs(at(a)[1] - at(b)[1]) < 1e-6, `${a} mirrors ${b}`);
  }
  const length = (a: keyof typeof ANCHOR, b: keyof typeof ANCHOR) => Math.hypot(...at(a).map((value, k) => value - at(b)[k]));
  const waving = solvePose(gestureTarget("greeting", 1.2));
  const wave = (a: keyof typeof ANCHOR, b: keyof typeof ANCHOR) => Math.hypot(...[0, 1, 2].map(k => waving[ANCHOR[a] * 3 + k] - waving[ANCHOR[b] * 3 + k]));
  assert.ok(Math.abs(wave("shoulderRight", "elbowRight") - length("shoulderRight", "elbowRight")) < 0.02, "the upper arm keeps its length");
  assert.ok(waving[ANCHOR.handRight * 3 + 1] > waving[ANCHOR.shoulderRight * 3 + 1], "greeting raises one hand above the shoulder");
  assert.ok(waving[ANCHOR.handLeft * 3 + 1] < p[ANCHOR.spine * 3 + 1] + 0.1, "…and only one");
});

test("the animated greeting raises one hand only, through the animator", () => {
  const animator = new FigureAnimator();
  let anchors: Float32Array = animator.anchors;
  for (let t = 0; t < 1.3; t += 1 / 60) anchors = animator.sample(1 / 60, "greeting", t);
  const y = (name: keyof typeof ANCHOR) => anchors[ANCHOR[name] * 4 + 1];
  assert.ok(y("handRight") > y("shoulderRight"), "the right hand is raised");
  assert.ok(y("handLeft") < y("spine") + 0.2 * FIGURE_SCALE, "the left arm stays down");
  assert.notEqual(animator.params.left, animator.params.right, "each arm is animated on its own");
});

test("every state's pose is valid, bounded and subtle", () => {
  const animator = new FigureAnimator();
  const neutral = solvePose(NEUTRAL_POSE);
  for (const state of AION_STATES) {
    for (let t = 0; t < 3; t += 0.1) {
      const anchors = animator.sample(0.1, state, t, 0.8);
      assert.ok(finite(anchors), `${state} finite`);
      for (let i = 0; i < ANCHOR_COUNT; i++) {
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(anchors[i * 4 + k]) <= FIGURE_SCALE, `${state} ${ANCHORS[i]} bounded`);
      }
    }
    // Only the greeting and presenting move a hand far; every other state stays near neutral.
    if (state !== "greeting" && state !== "presenting") {
      const pose = solvePose(gestureTarget(state, 0.5, 1));
      for (let i = 0; i < pose.length; i++) assert.ok(Math.abs(pose[i] - neutral[i]) < 0.12, `${state} is restrained`);
    }
  }
  assert.ok(finite(new FigureAnimator().sample(Number.NaN, "nonsense" as never, Number.NaN, Number.NaN)), "bad input stays finite");
});

test("the particle layout is a valid, bounded figure at every quality tier", () => {
  const count = 12_000;
  const layout = createFigureLayout(count);
  assert.equal(layout.bind.length, count * 4);
  assert.equal(layout.local.length, count * 4);
  const animator = new FigureAnimator();
  const kinds = new Set<number>();
  let near = 0, far = 0;
  for (const [state, t] of [["idle", 0], ["greeting", 1.2], ["presenting", 1], ["thinking", 2]] as const) {
    const anchors = animator.sample(1, state, t);
    for (let i = 0; i < count; i += 7) {
      const { position, tone, kind } = figurePoint(layout, i, anchors, { clock: t * 3, orbit: 1.2, thinking: 0.6 });
      kinds.add(kind);
      assert.ok(finite(position) && Number.isFinite(tone), `particle ${i}`);
      assert.ok(Math.abs(position[0]) < 2 && Math.abs(position[1]) < 2 && Math.abs(position[2]) < 2, `particle ${i} bounded`);
      assert.ok(tone >= 0 && tone <= 1.5);
      if (kind === FIGURE_KINDS.bone || kind === FIGURE_KINDS.ring || kind === FIGURE_KINDS.joint) near++; else far++;
    }
  }
  assert.deepEqual([...kinds].sort(), Object.values(FIGURE_KINDS).sort(), "every component is present");
  assert.ok(near > 0 && far > 0);
  // Quality tiers are prefixes: the first 6 000 particles still draw the whole figure.
  const prefix = new Set<number>(), anchorsUsed = new Set<number>();
  for (let i = 0; i < 6000; i++) {
    const { a, b, c, d, kind } = unpackAnchors(layout.bind[i * 4]);
    prefix.add(kind);
    for (const index of [a, b, c, d]) anchorsUsed.add(index);
  }
  assert.equal(prefix.size, Object.keys(FIGURE_KINDS).length);
  assert.equal(anchorsUsed.size, ANCHOR_COUNT, "every anchor has particles");
  assert.deepEqual(unpackAnchors(packAnchors(14, 3, 0, 9, 6)), { a: 14, b: 3, c: 0, d: 9, kind: 6 });
  assert.deepEqual(createFigureLayout(500).bind, createFigureLayout(500).bind, "deterministic");
});

test("the head ring turns with the head: tilting moves the ring, not just its centre", () => {
  const layout = createFigureLayout(4000);
  const upright = new FigureAnimator().sample(1, "idle", 0);
  const tiltAnimator = new FigureAnimator();
  let tilted = upright;
  for (let i = 0; i < 60; i++) tilted = tiltAnimator.sample(1 / 30, "curious", 1);
  const ring = Array.from({ length: 4000 }, (_, i) => i).filter(i => unpackAnchors(layout.bind[i * 4]).kind === FIGURE_KINDS.ring);
  assert.ok(ring.length > 100);
  const centre = (anchors: Float32Array) => {
    const sum = [0, 0];
    for (const i of ring) { const p = figurePoint(layout, i, anchors).position; sum[0] += p[0]; sum[1] += p[1]; }
    return sum.map(value => value / ring.length);
  };
  const [ux] = centre(upright), [tx] = centre(tilted);
  assert.ok(tx > ux + 0.01, "the ring follows the head's tilt toward the figure's left");
  const head = tilted[ANCHOR.head * 4];
  assert.ok(Math.abs(tx - head) < 0.05, "and stays centred on the head");
});

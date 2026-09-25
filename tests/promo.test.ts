import test from "node:test";
import assert from "node:assert/strict";
import { createSphere } from "../src/particle/sphere/createSphere";
import { formationState } from "../src/particle/formation";
import { BIRTH, BIRTH_END, arrivalTime, createBirthPlan } from "../src/promo/birth";
import { cameraPose, POSES, REST_POSE } from "../src/promo/camera";
import { filmLook, PromoDirector, type DirectorBody } from "../src/promo/director";
import { featherRaster, frameTarget } from "../src/promo/framing";
import { actionKey, cachedResolver, resolveSceneTargets, sceneAction, type ResolverInstance } from "../src/promo/preload";
import { COPY, DIALOGUE, LINE_IDS, VISUALS, type LineId } from "../src/promo/script";
import { createPerformance } from "../src/promo/session";
import { compileTimeline, frameCount, lineAt, SCENE_IDS, subtitleAt, timelineProblems, type Timeline } from "../src/promo/timeline";
import { spanOpacity } from "../src/promo/transitions";
import type { InformationAction } from "../src/visual-actions/controller";
import type { MorphTarget, Raster } from "../src/visual-actions/types";
import type { ToolExecution, ToolRunner } from "../src/voice/tools/executor";
import type { ResolveTrace } from "../src/visual-resolver/types";

const raster = (width = 8, height = 8, alpha = 255): Raster => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(alpha) });
const target = (label: string): MorphTarget => ({ label, hold: 5, visual: { kind: "raster2d", style: "glyph", raster: raster() } });

/** Film-ready targets for every scene, keyed exactly as the real preload keys them. */
function sceneTargets(timeline: Timeline) {
  const targets = new Map<string, MorphTarget>();
  for (const visual of timeline.visuals) {
    targets.set(actionKey(sceneAction(visual)), { ...target(visual.id), hold: visual.release - visual.formed + 1, transition: { form: visual.form, return: visual.return } });
  }
  return targets;
}

/** Plays a performance frame by frame at 60 fps, as export does. */
async function play(performance: ReturnType<typeof createPerformance>, until: number, from = 0, onFrame?: (t: number) => void) {
  for (let frame = Math.round(from * 60); frame <= Math.round(until * 60); frame++) {
    const t = frame / 60;
    await performance.director.update(t);
    performance.visual.sample(frame === 0 ? 0 : 1 / 60);
    performance.engine.sample(1 / 60, t);
    onFrame?.(t);
  }
}

// ── Timeline ──────────────────────────────────────────────────────────────────────────────────────

test("the film compiles to a sound ~60 s timeline with every scene in order", () => {
  const timeline = compileTimeline();
  assert.deepEqual(timelineProblems(timeline), []);
  assert.ok(timeline.duration >= 58 && timeline.duration <= 63, `runtime ${timeline.duration}`);
  assert.deepEqual(timeline.scenes.map(scene => scene.id), [...SCENE_IDS]);
  assert.deepEqual(timeline.visuals.map(v => v.id), ["tesla", "terrain", "emoji", "clock", "logo"]);
  assert.deepEqual(timeline.lines.map(l => l.id), [...LINE_IDS]);
  assert.equal(frameCount(timeline), Math.ceil(timeline.duration * 60));
  assert.deepEqual(timeline.nominal, [...LINE_IDS], "without recordings every line is timed from its nominal length");
});

test("every time in the timeline is finite, and cues are monotonic", () => {
  const timeline = compileTimeline();
  const times = [
    ...timeline.scenes.flatMap(s => [s.start, s.end]), ...timeline.lines.flatMap(l => [l.start, l.end]),
    ...timeline.visuals.flatMap(v => [v.start, v.formed, v.release, v.sphere]), ...timeline.titles.flatMap(t => [t.start, t.fadeIn, t.hold, t.fadeOut]),
    ...timeline.pulses.map(p => p.at), ...timeline.camera.moves.flatMap(m => [m.start, m.duration]), timeline.blackout.start, timeline.blackout.duration,
  ];
  assert.ok(times.every(Number.isFinite));
  const starts = timeline.visuals.flatMap(v => [v.start, v.formed, v.release, v.sphere]);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "expressions never overlap: each returns to the sphere before the next");
  for (let i = 1; i < timeline.lines.length; i++) assert.ok(timeline.lines[i].start >= timeline.lines[i - 1].end, "no two lines overlap");
});

test("recorded line lengths re-time the film; unusable ones fall back to nominal", () => {
  const long = Object.fromEntries(LINE_IDS.map(id => [id, DIALOGUE[id].nominal + 0.4])) as Record<LineId, number>;
  const timeline = compileTimeline(long);
  assert.deepEqual(timelineProblems(timeline), []);
  assert.equal(timeline.nominal.length, 0);
  assert.ok(timeline.duration > compileTimeline().duration);
  const odd = compileTimeline({ "tesla.user": Number.NaN, "tesla.assistant": -1, "clock.user": 99 });
  assert.deepEqual(odd.nominal.slice(0, 2), ["tesla.user", "tesla.assistant"]);
  assert.ok(odd.nominal.includes("clock.user"));
  assert.deepEqual(timelineProblems(odd), []);
});

test("the caption lives on the formed terrain, the question on the formed body, and nothing starts during the birth", () => {
  const timeline = compileTimeline();
  const caption = timeline.titles.find(t => t.id === "caption")!, terrain = timeline.visuals.find(v => v.id === "terrain")!;
  assert.ok(caption.start >= terrain.formed && caption.start + caption.fadeIn + caption.hold + caption.fadeOut <= terrain.release);
  assert.ok(timeline.titles.find(t => t.id === "question")!.start >= timeline.birth.end);
  assert.ok(timeline.visuals.every(v => v.start > timeline.birth.end));
  // The logo is the last expression and its release is the outro.
  const logo = timeline.visuals.at(-1)!;
  assert.equal(timeline.scenes.find(s => s.id === "outro")!.start, logo.release);
  assert.ok(logo.form > timeline.visuals.find(v => v.id === "clock")!.form, "the brand forms more deliberately than the clock");
});

test("only the principal editorial lines appear, and subtitles follow the dialogue", () => {
  assert.deepEqual(Object.values(COPY), ["What if AI could have a presence?", "Information becomes form.", "Intelligence Presence", "One voice. One body. Infinite forms.", "Spirit Connect"]);
  const timeline = compileTimeline();
  const line = timeline.lines[0];
  assert.equal(lineAt(timeline, line.start + 0.1)?.id, line.id);
  assert.equal(subtitleAt(timeline, line.start + 0.5)?.line.text, "Show me Nikola Tesla.");
  assert.equal(subtitleAt(timeline, 0), null);
  assert.ok(Object.values(DIALOGUE).every(l => !/^(USER|ASSISTANT)/i.test(l.text)));
});

test("the scene tool calls are the real requests: Tesla, the United Kingdom, 🎉, 18:42 and the local Spirit Connect logo", () => {
  const actions = compileTimeline().visuals.map(sceneAction);
  assert.deepEqual(actions, [
    { type: "portrait", person: "Nikola Tesla" },
    { type: "terrain", region: "United Kingdom" },
    { type: "emoji", value: "🎉" },
    { type: "clock", time: "18:42" },
    { type: "image", query: "Spirit Connect logo" },
  ]);
  assert.deepEqual(VISUALS.terrain.args, { region: "United Kingdom" }, "the United Kingdom, not Wales");
  assert.equal(VISUALS.clock.tool, "show_clock");
});

// ── Birth ─────────────────────────────────────────────────────────────────────────────────────────

test("the birth plan is deterministic, sparse at first, and every grain has arrived by the end of the birth", () => {
  const count = 6000;
  const { positions } = createSphere(count, 1.35);
  const a = createBirthPlan(positions, count), b = createBirthPlan(positions, count);
  assert.deepEqual(a.launch, b.launch);
  assert.deepEqual(a.path, b.path);
  assert.ok(a.end <= BIRTH_END + 1e-6 && a.end > BIRTH_END - 0.3, `end ${a.end}`);
  let launchedEarly = 0, arrivedEarly = 0, arrivedMid = 0;
  for (let i = 0; i < count; i++) {
    const at = a.launch[i * 4 + 3], flight = a.path[i * 4];
    assert.ok(Number.isFinite(at) && Number.isFinite(flight) && flight >= BIRTH.minFlight - 1e-6);
    assert.ok(at >= BIRTH.firstLaunch - 1e-6, "nothing exists in the first moment");
    if (at < 1.6) launchedEarly++;
    if (at + flight < 4.5) arrivedEarly++;
    if (at + flight < 6.6) arrivedMid++;
  }
  assert.ok(launchedEarly / count < 0.12, `a small number appear first (${launchedEarly})`);
  assert.ok(arrivedEarly / count < 0.2, "only hints of the sphere by ~4.5 s");
  assert.ok(arrivedMid / count > 0.8 && arrivedMid / count < 0.95, "almost formed by 6–7 s, the last grains still arriving");
  assert.equal(arrivalTime(0), BIRTH.arrivals[0][0]);
  assert.equal(arrivalTime(1), BIRTH_END);
});

test("formation hands over to the ordinary sphere exactly: after the birth every grain is where the body holds it", () => {
  const count = 500;
  const { positions } = createSphere(count, 1.35);
  const plan = createBirthPlan(positions, count);
  for (let i = 0; i < count; i++) {
    const rest = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] as const;
    const settled = [rest[0] + 0.01, rest[1] - 0.02, rest[2]] as const;
    const done = formationState(plan, i, rest, plan.end + 0.01, settled);
    done.position.forEach((value, k) => assert.ok(Math.abs(value - settled[k]) < 1e-12, "captured exactly by the body"));
    assert.equal(done.capture, 1);
    assert.equal(done.visible, 1);
    const before = formationState(plan, i, rest, 0);
    assert.equal(before.visible, 0, "invisible before it comes into existence");
    // Continuous: no snap in the last moments of the flight.
    const at = plan.launch[i * 4 + 3], flight = plan.path[i * 4];
    const late = formationState(plan, i, rest, at + flight * 0.995, settled);
    assert.ok(Math.hypot(...late.position.map((v, k) => v - settled[k]) as [number, number, number]) < 0.02);
    assert.ok(late.position.every(Number.isFinite));
  }
});

test("the timeline's birth matches the formation plan and ends in the normal body", () => {
  const timeline = compileTimeline();
  assert.equal(timeline.birth.end, BIRTH_END);
  assert.ok(filmLook(timeline, timeline.birth.end).formation >= BIRTH_END);
  assert.equal(timeline.pulses[0].at < timeline.birth.end + 0.2, true, "the soft pulse marks the completed body");
});

// ── Look: camera, titles, black ───────────────────────────────────────────────────────────────────

test("the camera stages gently: birth → rest, terrain view and back, outro pullback", () => {
  const timeline = compileTimeline();
  const { initial, moves } = timeline.camera;
  assert.deepEqual(cameraPose(initial, moves, 0), POSES.birth);
  const tesla = timeline.visuals[0];
  const portrait = cameraPose(initial, moves, tesla.formed);
  assert.ok(portrait.yaw === 0 && portrait.pitch === 0 && portrait.lift === 0 && portrait.distance < 1 && portrait.distance >= POSES.hold.distance,
    "the portrait is frontal, with a subconscious push-in");
  const terrain = timeline.visuals[1];
  const staged = cameraPose(initial, moves, terrain.formed + 1.5);
  assert.ok(Math.abs(staged.yaw - POSES.terrain.yaw) < 1e-6 && Math.abs(staged.pitch - POSES.terrain.pitch) < 1e-6);
  assert.ok(Math.abs(staged.yaw) < 0.3, "no orbit: a small turn only");
  assert.deepEqual(cameraPose(initial, moves, timeline.visuals[2].start), REST_POSE, "back to the primary framing");
  assert.deepEqual(cameraPose(initial, moves, timeline.duration), POSES.outro);
  // Smooth: no jumps between consecutive frames.
  let previous = cameraPose(initial, moves, 0);
  for (let t = 0; t <= timeline.duration; t += 1 / 60) {
    const pose = cameraPose(initial, moves, t);
    assert.ok(Math.abs(pose.yaw - previous.yaw) < 0.01 && Math.abs(pose.distance - previous.distance) < 0.01 && Math.abs(pose.lift - previous.lift) < 0.01, `camera jump at ${t}`);
    previous = pose;
  }
});

test("the film starts and ends in black, with the outro titles fully visible before the fade", () => {
  const timeline = compileTimeline();
  const start = filmLook(timeline, 0);
  assert.equal(start.blackout, 0);
  assert.ok(Object.values(start.titles).every(title => title.opacity === 0));
  const end = filmLook(timeline, timeline.duration);
  assert.equal(end.blackout, 1);
  const composed = filmLook(timeline, timeline.blackout.start - 0.01);
  for (const id of ["title", "tagline", "maker"] as const) assert.equal(composed.titles[id].opacity, 1, id);
  assert.equal(composed.titles.question.opacity, 0);
  const question = timeline.titles.find(t => t.id === "question")!;
  assert.equal(spanOpacity(question, question.start + question.fadeIn + 0.1), 1);
});

// ── Preload ───────────────────────────────────────────────────────────────────────────────────────

function fakeResolver(overrides: Partial<Record<string, { provider: string; source?: string } | "fail">> = {}, calls: InformationAction[] = []): () => ResolverInstance {
  return () => {
    const instance: ResolverInstance & { lastTrace: ResolveTrace | null } = {
      lastTrace: null,
      resolve: async action => {
        calls.push(action);
        const override = overrides[action.type];
        if (override === "fail") { instance.lastTrace = { action: action.type, status: "failed", chain: [], fetchMs: 0, error: `${action.type}-unavailable` }; throw new Error(`${action.type}-unavailable`); }
        const provider = override?.provider ?? (action.type === "terrain" ? "aws-terrain-tiles z5 · nominatim" : action.type === "image" ? "local-assets" : "wikipedia");
        const source = override?.source ?? (action.type === "image" ? "/assets/brand/spirit-connect-logo.svg" : "somewhere");
        instance.lastTrace = { action: action.type, status: "resolved", chain: [], fetchMs: 0, provider, source };
        return target(action.type);
      },
    };
    return instance;
  };
}

test("preload resolves every scene through the resolver and serves the film from memory", async () => {
  const timeline = compileTimeline();
  const calls: InformationAction[] = [];
  const { targets, visuals } = await resolveSceneTargets(timeline, fakeResolver({}, calls), { wait: async () => {} });
  assert.equal(targets.size, 5);
  assert.deepEqual(calls.map(c => c.type).sort(), ["clock", "emoji", "image", "portrait", "terrain"]);
  assert.deepEqual(visuals.map(v => v.id), ["tesla", "terrain", "emoji", "clock", "logo"]);
  const logo = visuals.find(v => v.id === "logo")!;
  assert.equal(logo.provider, "local-assets");
  // Film-ready: held until the director releases them, with the scene's own morph durations.
  const tesla = targets.get(actionKey({ type: "portrait", person: "Nikola Tesla" }))!;
  assert.deepEqual(tesla.transition, { form: timeline.visuals[0].form, return: timeline.visuals[0].return });
  assert.ok(tesla.hold > timeline.visuals[0].release - timeline.visuals[0].formed);
  const served = await cachedResolver(targets)({ type: "emoji", value: "🎉" }, new AbortController().signal);
  assert.equal(served.label, "emoji");
  await assert.rejects(cachedResolver(targets)({ type: "emoji", value: "😊" }, new AbortController().signal), /promo-target-missing/);
});

test("preload fails explicitly: a wrong logo source or an approximate relief is never accepted", async () => {
  const timeline = compileTimeline();
  await assert.rejects(resolveSceneTargets(timeline, fakeResolver({ image: { provider: "wikipedia", source: "https://example" } }), { wait: async () => {} }),
    (error: Error & { code?: string }) => error.code === "wrong-source" && /logo/.test((error as { detail?: string }).detail ?? ""));
  await assert.rejects(resolveSceneTargets(timeline, fakeResolver({ terrain: { provider: "relief-image" } }), { wait: async () => {} }),
    (error: Error & { code?: string }) => error.code === "wrong-source");
});

test("preload retries a failing provider, then reports the scene as unavailable", async () => {
  const timeline = compileTimeline();
  const calls: InformationAction[] = [];
  const waits: number[] = [];
  await assert.rejects(
    resolveSceneTargets(timeline, fakeResolver({ portrait: "fail" }, calls), { attempts: 3, backoffMs: [1, 2], wait: async ms => { waits.push(ms); } }),
    (error: Error & { code?: string; detail?: string }) => error.code === "target-unavailable" && error.detail === "tesla: portrait-unavailable",
  );
  assert.equal(calls.filter(c => c.type === "portrait").length, 3);
  assert.deepEqual(waits, [1, 2]);
});

test("film framing feathers only the portrait photograph, through alpha", () => {
  const photo = raster(40, 50);
  const feathered = featherRaster(photo);
  const alpha = (x: number, y: number) => feathered.data[(y * 40 + x) * 4 + 3];
  assert.equal(alpha(20, 22), 255, "the face stays whole");
  assert.equal(alpha(0, 0), 0, "the corners dissolve");
  assert.deepEqual(feathered.data.filter((_, i) => i % 4 !== 3), photo.data.filter((_, i) => i % 4 !== 3), "tones are untouched");
  const portrait: MorphTarget = { label: "p", hold: 1, visual: { kind: "raster2d", style: "portrait", raster: photo } };
  assert.notEqual(frameTarget("tesla", portrait), portrait);
  const glyph = target("clock");
  assert.equal(frameTarget("clock", glyph), glyph);
});

// ── Director ──────────────────────────────────────────────────────────────────────────────────────

function recordingBody() {
  const calls: string[] = [];
  const body: DirectorBody & { calls: string[] } = {
    calls,
    setConversation: source => calls.push(`conversation ${source ? "set" : "cleared"}`),
    setMicrophone: input => calls.push(`microphone ${input ? "set" : "cleared"}`),
    assistantAudio: () => {},
    triggerFocus: strength => { calls.push(`pulse ${strength}`); return true; },
  };
  return body;
}
const okRunner = (log: string[], fail?: string): ToolRunner => ({
  execute: async (name, args) => {
    log.push(`${name} ${args}`);
    const ok = name !== fail;
    return { name, action: null, result: ok ? { ok: true, status: name === "return_to_sphere" ? "returning" : "displayed" } : { ok: false, status: "image-unavailable" }, ms: 0 } satisfies ToolExecution;
  },
});

test("the director fires each cue exactly once, in order, and time only moves forward", async () => {
  const timeline = compileTimeline();
  const log: string[] = [];
  const body = recordingBody();
  const director = new PromoDirector(timeline, { runner: okRunner(log), body, voices: new Map() });
  for (let frame = 0; frame <= Math.ceil(timeline.duration * 60); frame++) await director.update(frame / 60);
  await director.update(3); // a rewind is ignored
  assert.equal(log.length, 10);
  assert.deepEqual(log.filter((_, i) => i % 2 === 0), [
    'show_portrait {"person":"Nikola Tesla"}', 'show_terrain {"region":"United Kingdom"}', 'show_emoji {"emoji":"🎉"}',
    'show_clock {"time":"18:42"}', 'show_image {"query":"Spirit Connect logo"}',
  ]);
  assert.ok(log.filter((_, i) => i % 2 === 1).every(call => call === "return_to_sphere {}"));
  assert.equal(body.calls.filter(c => c.startsWith("pulse")).length, 2);
  assert.equal(director.pending, 0);
  assert.ok(director.ended);
  assert.deepEqual(director.record.map(r => r.outcome), ["displayed", "returning", "displayed", "returning", "displayed", "returning", "displayed", "returning", "displayed", "returning"]);
});

test("the director drives listening and thinking from the script", () => {
  const timeline = compileTimeline();
  const director = new PromoDirector(timeline, { runner: okRunner([]), body: recordingBody(), voices: new Map() });
  const user = timeline.lines[0];
  assert.deepEqual(director.hints(user.start + 0.2), { live: true, userSpeaking: true, awaitingResponse: false, toolActive: false });
  const thinking = timeline.thinking[0];
  assert.equal(director.hints(thinking.start + 0.05).awaitingResponse, true);
  assert.equal(director.hints(timeline.visuals[0].start + 0.01).toolActive, true);
  assert.deepEqual(director.hints(1), { live: true, userSpeaking: false, awaitingResponse: false, toolActive: false });
});

test("a scene that cannot be shown stops the film loudly instead of substituting", async () => {
  const timeline = compileTimeline();
  const failures: string[] = [];
  const director = new PromoDirector(timeline, { runner: okRunner([], "show_portrait"), body: recordingBody(), voices: new Map(), onFailure: error => failures.push(error.detail) });
  await director.update(timeline.visuals[0].start + 0.01);
  assert.equal(director.failure?.code, "visual-failed");
  assert.deepEqual(failures, ["show_portrait (tesla): image-unavailable"]);
});

test("stop() cancels the remaining cues and releases the engine", async () => {
  const timeline = compileTimeline();
  const log: string[] = [];
  const body = recordingBody();
  const director = new PromoDirector(timeline, { runner: okRunner(log), body, voices: new Map() });
  await director.update(timeline.visuals[0].start + 0.1);
  director.stop();
  await director.update(timeline.duration);
  assert.equal(log.length, 1);
  assert.deepEqual(body.calls.slice(0, 2), ["conversation set", "microphone set"]);
  assert.deepEqual(body.calls.slice(-2), ["conversation cleared", "microphone cleared"]);
});

// ── A whole performance through the real executor and controller ─────────────────────────────────

test("a performance runs every expression through the real ToolExecutor and returns to the sphere", async () => {
  const timeline = compileTimeline();
  const performance = createPerformance(timeline, sceneTargets(timeline), new Map());
  const seen: Record<string, string> = {};
  await play(performance, timeline.duration, 0, t => {
    for (const v of timeline.visuals) {
      if (Math.abs(t - (v.formed + 0.2)) < 1 / 120) seen[v.id] = `${performance.visual.phase} ${performance.visual.target?.label} ${performance.visual.level.toFixed(2)}`;
    }
  });
  assert.deepEqual(seen, { tesla: "holding tesla 1.00", terrain: "holding terrain 1.00", emoji: "holding emoji 1.00", clock: "holding clock 1.00", logo: "holding logo 1.00" });
  assert.equal(performance.visual.phase, "sphere", "the film ends on the body itself");
  assert.equal(performance.director.failure, null);
  assert.equal(performance.engine.signal.mode, "idle");
});

test("the clock is deterministic: 18:42 whatever the time of day", async () => {
  const timeline = compileTimeline();
  const performance = createPerformance(timeline, sceneTargets(timeline), new Map());
  const execution = await performance.executor.execute("show_clock", JSON.stringify(VISUALS.clock.args));
  assert.equal(execution.result.shown, "18:42");
  const noTime = await performance.executor.execute("show_clock", "{}");
  assert.notEqual(noTime.result.ok, undefined);
});

test("replay: a new performance starts from the sphere and performs every cue again", async () => {
  const timeline = compileTimeline();
  const targets = sceneTargets(timeline);
  const first = createPerformance(timeline, targets, new Map());
  await play(first, timeline.visuals[1].start + 0.5);
  assert.equal(first.visual.phase, "forming");
  first.dispose();
  await first.director.update(timeline.duration);
  assert.equal(first.director.record.length, 3, "a stopped performance performs nothing more");
  const second = createPerformance(timeline, targets, new Map());
  assert.equal(second.visual.phase, "sphere");
  await play(second, timeline.duration);
  assert.equal(second.director.record.length, 10);
  assert.equal(second.visual.phase, "sphere");
});

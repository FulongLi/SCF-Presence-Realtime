import test from "node:test";
import assert from "node:assert/strict";
import { VISUAL_TOOL_NAMES, visualTools } from "../src/voice/tools/definitions";
import { normalizeClockTime, parseToolArguments, toolCallToVisualAction, ToolExecutor, type VisualBody } from "../src/voice/tools/executor";
import { failureStatus, serializeResult } from "../src/voice/tools/results";
import { VisualActionController, type SubmitOutcome } from "../src/visual-actions/controller";
import { IMAGE_INTENTS, SYMBOL_NAMES, TERRAIN_STYLES, type MorphTarget, type VisualAction } from "../src/visual-actions/types";
import { PRESENCE_INSTRUCTIONS } from "../src/realtime/instructions";

test("the native tool set is small, fully described and strict", () => {
  assert.deepEqual(visualTools.map(tool => tool.name), [...VISUAL_TOOL_NAMES]);
  for (const tool of visualTools) {
    assert.equal(tool.type, "function");
    assert.ok(tool.description.length > 40, tool.name);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    for (const key of tool.parameters.required) assert.ok(key in tool.parameters.properties);
  }
  const symbol = visualTools.find(tool => tool.name === "show_symbol")!;
  assert.deepEqual(symbol.parameters.properties.symbol.enum, [...SYMBOL_NAMES], "the symbol allowlist is the Visual Action allowlist");
  assert.match(visualTools.find(tool => tool.name === "show_portrait")!.description, /Do not call just because a name appears/);
});

test("tool calls resolve into the one shared VisualAction schema", () => {
  assert.deepEqual(toolCallToVisualAction("show_clock", {}), { type: "clock" });
  assert.deepEqual(toolCallToVisualAction("show_clock", { time: "15:42" }), { type: "clock", time: "15:42" });
  assert.deepEqual(toolCallToVisualAction("show_portrait", { person: "  Nikola   Tesla " }), { type: "portrait", person: "Nikola Tesla" });
  assert.deepEqual(toolCallToVisualAction("show_number", { value: "42%" }), { type: "number", value: "42%" });
  assert.deepEqual(toolCallToVisualAction("show_number", { value: "£28,000" }), { type: "number", value: "£28,000" });
  assert.deepEqual(toolCallToVisualAction("show_text", { value: "Hello" }), { type: "text", value: "Hello" });
  assert.deepEqual(toolCallToVisualAction("show_symbol", { symbol: "Check" }), { type: "symbol", value: "check" });
  assert.deepEqual(toolCallToVisualAction("return_to_sphere", {}), { type: "sphere" });
});

test("invalid tool arguments are rejected before reaching the body", () => {
  const rejected: [Parameters<typeof toolCallToVisualAction>[0], Record<string, unknown>][] = [
    ["show_clock", { time: "25:00" }], ["show_clock", { time: 1542 }], ["show_clock", { time: "15:42", zone: "UTC" }],
    ["show_portrait", {}], ["show_portrait", { person: "javascript:alert(1)" }], ["show_portrait", { person: "Tesla", imageUrl: "https://evil.test/a.jpg" }],
    ["show_number", { value: "forty-two" }], ["show_number", { value: 42 }],
    ["show_text", { value: "<img src=x onerror=alert(1)>" }], ["show_text", { value: "a very long label indeed" }],
    ["show_symbol", { symbol: "skull" }], ["return_to_sphere", { now: true }],
  ];
  for (const [name, args] of rejected) assert.equal(toolCallToVisualAction(name, args), null, `${name} ${JSON.stringify(args)}`);
  assert.deepEqual(parseToolArguments(""), {});
  assert.equal(parseToolArguments("{\"value\":"), null);
  assert.equal(parseToolArguments("[1]"), null);
});

test("clock times from the model are normalized only when unambiguous", () => {
  assert.equal(normalizeClockTime("15:42"), "15:42");
  assert.equal(normalizeClockTime("7:05"), "07:05");
  assert.equal(normalizeClockTime("3:42 PM"), "15:42");
  assert.equal(normalizeClockTime("12:00 am"), "00:00");
  assert.equal(normalizeClockTime("12:30 p.m."), "12:30");
  assert.equal(normalizeClockTime("15:42:10"), "15:42");
  for (const value of ["24:00", "13:00 pm", "3 pm", "noon", "12:60", ""]) assert.equal(normalizeClockTime(value), null, value);
});

function executor(outcome: (action: VisualAction) => Promise<SubmitOutcome>, lastFailure: string | null = null, budgetMs = 50) {
  const submitted: VisualAction[] = [];
  const visual: VisualBody = { submit: action => { submitted.push(action); return outcome(action); }, lastFailure };
  const run = new ToolExecutor(visual, {
    budgetMs, now: () => new Date(2026, 8, 24, 21, 7), timeZone: () => "Europe/London",
  });
  return { run, submitted };
}

test("executor: a clock without a time shows and reports the user's local time", async () => {
  const { run, submitted } = executor(async () => "queued");
  const result = await run.execute("show_clock", "{}");
  assert.deepEqual(submitted, [{ type: "clock" }]);
  assert.deepEqual(result.result, { ok: true, status: "displayed", shown: "21:07", timeZone: "Europe/London" });
  assert.equal(serializeResult(result.result), "{\"ok\":true,\"status\":\"displayed\",\"shown\":\"21:07\",\"timeZone\":\"Europe/London\"}");
});

test("executor: text, number, symbol and sphere report concise results", async () => {
  const { run } = executor(async action => action.type === "sphere" ? "sphere" : "queued");
  assert.deepEqual((await run.execute("show_number", "{\"value\":\"42%\"}")).result, { ok: true, status: "displayed" });
  assert.deepEqual((await run.execute("show_text", "{\"value\":\"Hello\"}")).result, { ok: true, status: "displayed" });
  assert.deepEqual((await run.execute("show_symbol", "{\"symbol\":\"star\"}")).result, { ok: true, status: "displayed" });
  assert.deepEqual((await run.execute("return_to_sphere", "")).result, { ok: true, status: "returning" });
});

test("executor: invalid calls never touch the body", async () => {
  const { run, submitted } = executor(async () => "queued");
  assert.deepEqual((await run.execute("show_text", "{\"value\":\"<b>\"}")).result, { ok: false, status: "invalid-arguments" });
  assert.deepEqual((await run.execute("show_text", "not json")).result, { ok: false, status: "invalid-arguments" });
  assert.deepEqual((await run.execute("open_url", "{}")).result, { ok: false, status: "unknown-tool" });
  assert.equal(submitted.length, 0);
});

test("executor: a missing portrait fails cleanly; a slow one reports forming without blocking", async () => {
  const missing = executor(async () => "failed", "portrait-not-found");
  const result = await missing.run.execute("show_portrait", "{\"person\":\"Nobody In Particular\"}");
  assert.deepEqual(result.result, { ok: false, status: "portrait-not-found" });
  assert.deepEqual(result.action, { type: "portrait", person: "Nobody In Particular" });
  const slow = executor(() => new Promise(() => {}), null, 20);
  assert.deepEqual((await slow.run.execute("show_portrait", "{\"person\":\"Nikola Tesla\"}")).result, { ok: true, status: "forming" });
  const replaced = executor(async () => "cancelled");
  assert.deepEqual((await replaced.run.execute("show_text", "{\"value\":\"Paris\"}")).result, { ok: false, status: "superseded" });
  assert.deepEqual(failureStatus("portrait-too-large"), { ok: false, status: "portrait-unavailable" });
  assert.deepEqual(failureStatus("image-too-large"), { ok: false, status: "image-unavailable" });
  assert.deepEqual(failureStatus("canvas-unavailable"), { ok: false, status: "unresolved" });
});

test("executor drives the real VisualActionController: sphere → visual → sphere", async () => {
  const target: MorphTarget = { visual: { kind: "raster2d", raster: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) }, style: "glyph" }, hold: 1, label: "42%" };
  const controller = new VisualActionController(async () => target);
  const run = new ToolExecutor(controller, { budgetMs: 100, now: () => new Date(), timeZone: () => "UTC" });
  assert.equal((await run.execute("show_number", "{\"value\":\"42%\"}")).result.status, "displayed");
  for (let i = 0; i < 60 * 2; i++) controller.sample(1 / 60);
  assert.equal(controller.phase, "holding");
  assert.equal((await run.execute("return_to_sphere", "{}")).result.status, "returning");
  for (let i = 0; i < 60 * 2; i++) controller.sample(1 / 60);
  assert.equal(controller.phase, "sphere");
  assert.equal(controller.level, 0);
});

test("show_image and show_terrain: open queries map onto validated image and terrain actions", () => {
  assert.deepEqual(toolCallToVisualAction("show_image", { query: " Tesla   Model Y ", intent: "vehicle" }), { type: "image", query: "Tesla Model Y", intent: "vehicle" });
  assert.deepEqual(toolCallToVisualAction("show_image", { query: "futuristic concept car" }), { type: "image", query: "futuristic concept car" });
  assert.deepEqual(toolCallToVisualAction("show_image", { query: "Taylor Swift", intent: "Celebrity" }), { type: "image", query: "Taylor Swift", intent: "celebrity" });
  assert.deepEqual(toolCallToVisualAction("show_image", { query: "Node.js logo", intent: "person" }), { type: "image", query: "Node.js logo" }, "an unknown intent is only a hint");
  assert.deepEqual(toolCallToVisualAction("show_image", { query: "埃菲尔铁塔", intent: null }), { type: "image", query: "埃菲尔铁塔" });
  assert.deepEqual(toolCallToVisualAction("show_terrain", { region: "Wales", style: "terrain" }), { type: "terrain", region: "Wales", style: "terrain" });
  assert.deepEqual(toolCallToVisualAction("show_terrain", { region: "United Kingdom", style: "topography" }), { type: "terrain", region: "United Kingdom", style: "topography" });
  assert.deepEqual(toolCallToVisualAction("show_terrain", { region: "Swiss Alps" }), { type: "terrain", region: "Swiss Alps" });
  const rejected: [Parameters<typeof toolCallToVisualAction>[0], Record<string, unknown>][] = [
    ["show_image", {}], ["show_image", { query: "" }], ["show_image", { query: 42 }], ["show_image", { query: "x".repeat(101) }],
    ["show_image", { query: "https://evil.test/a.jpg" }], ["show_image", { query: "<img src=x onerror=alert(1)>" }],
    ["show_image", { query: "javascript:alert(1)" }], ["show_image", { query: "cat", url: "https://evil.test" }],
    ["show_image", { query: "cat", intent: 3 }], ["show_image", { query: "bad‮text" }], ["show_image", { query: "..." }],
    ["show_terrain", {}], ["show_terrain", { region: "www.evil.test" }], ["show_terrain", { region: "Wales", style: 1 }],
    ["show_terrain", { region: "Wales", zoom: 12 }], ["show_terrain", { region: "x".repeat(81) }],
  ];
  for (const [name, args] of rejected) assert.equal(toolCallToVisualAction(name, args), null, `${name} ${JSON.stringify(args)}`);
});

test("executor: show_image and show_terrain report concise results, including their failures", async () => {
  const shown = executor(async () => "queued");
  assert.deepEqual((await shown.run.execute("show_image", "{\"query\":\"Tesla Model Y\",\"intent\":\"vehicle\"}")).result, { ok: true, status: "displayed" });
  assert.deepEqual((await shown.run.execute("show_terrain", "{\"region\":\"Wales\"}")).result, { ok: true, status: "displayed" });
  assert.deepEqual(shown.submitted, [{ type: "image", query: "Tesla Model Y", intent: "vehicle" }, { type: "terrain", region: "Wales" }]);
  for (const [name, args, code] of [
    ["show_image", "{\"query\":\"Qwxyzzy\"}", "image-not-found"], ["show_image", "{\"query\":\"cat\"}", "image-unavailable"],
    ["show_terrain", "{\"region\":\"Narnia\"}", "region-not-found"], ["show_terrain", "{\"region\":\"Wales\"}", "terrain-unavailable"],
  ] as const) {
    const run = executor(async () => "failed", code);
    assert.deepEqual((await run.run.execute(name, args)).result, { ok: false, status: code });
  }
  const slow = executor(() => new Promise(() => {}), null, 20);
  assert.deepEqual((await slow.run.execute("show_terrain", "{\"region\":\"United Kingdom\"}")).result, { ok: true, status: "forming" });
  assert.deepEqual(failureStatus("heightfield-empty"), { ok: false, status: "terrain-unavailable" });
  assert.deepEqual((await shown.run.execute("show_image", "{\"query\":\"<script>\"}")).result, { ok: false, status: "invalid-arguments" });
});

test("the open tools lead the tool set and say what they can show", () => {
  const image = visualTools.find(tool => tool.name === "show_image")!;
  const terrain = visualTools.find(tool => tool.name === "show_terrain")!;
  assert.deepEqual(image.parameters.required, ["query"]);
  assert.deepEqual(image.parameters.properties.intent.enum, [...IMAGE_INTENTS]);
  assert.deepEqual(terrain.parameters.required, ["region"]);
  assert.deepEqual(terrain.parameters.properties.style.enum, [...TERRAIN_STYLES]);
  assert.match(image.description, /person, vehicle, product, object/);
  assert.equal(VISUAL_TOOL_NAMES.length, 9, "two open tools, one emoji tool and six convenience tools; no per-object or per-emoji tools");
  assert.match(PRESENCE_INSTRUCTIONS, /not limited to a small fixed vocabulary/);
  assert.match(PRESENCE_INSTRUCTIONS, /Never mention tools/);
});

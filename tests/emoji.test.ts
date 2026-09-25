import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_BACKEND_INSTRUCTIONS, LIVE_VOICE_INSTRUCTIONS } from "../src/live/instructions";
import { buildLiveSessionConfig, liveOptionsFromEnv } from "../src/live/session";
import { PRESENCE_INSTRUCTIONS } from "../src/realtime/instructions";
import { buildSessionConfig, sessionOptionsFromEnv } from "../src/realtime/session";
import { VisualActionController } from "../src/visual-actions/controller";
import { HOLD_SECONDS, SYMBOL_NAMES, type VisualAction } from "../src/visual-actions/types";
import { isSingleEmojiGrapheme, validateVisualAction } from "../src/visual-actions/validate";
import { createTargetPoints } from "../src/visual-resolver/points";
import { createEmojiRasterizer, trimEmoji } from "../src/visual-resolver/providers/emoji";
import { VisualResolver } from "../src/visual-resolver/resolve";
import { trimTransparent } from "../src/visual-resolver/transforms/crop";
import type { ImageProvider, Raster, Raster2DTarget, TerrainProvider } from "../src/visual-resolver/types";
import { VISUAL_TOOL_NAMES, visualTools } from "../src/voice/tools/definitions";
import { toolCallToVisualAction, ToolExecutor, type VisualBody } from "../src/voice/tools/executor";
import { VISUAL_TOOL_RULES } from "../src/voice/visualGuidance";

const ACCEPTED = ["😊", "😂", "🤔", "😮", "❤️", "👍", "🎉", "⚡", "🚀", "💡", "🌍", "✅", "⚠️", "👨‍🚀", "🇬🇧", "👍🏻", "👨‍👩‍👧‍👦", "1️⃣", "🏴󠁧󠁢󠁷󠁬󠁳󠁿", "🏳️‍🌈"];
const REJECTED: unknown[] = [
  "", " ", "hello", "A", "1", "#", "😊😂", "🇬🇧🇺🇸", "<script>", "<😊>", "https://example.com/😊.png", "www.example.com", "javascript:alert(1)",
  " 😊", "😊 ", "😊a", "a😊", "😊\u0000", "😊‮", "‍", "️", "🏻", "🇬", "\u{1fc00}", "😊‍😂‍🤔‍🎉‍🚀", "😊".repeat(20),
  null, undefined, 42, ["😊"], { emoji: "😊" },
];

/**
 * A synthetic 😊 on transparency: a yellow disc with two dark eyes and a dark mouth. Stands in for the
 * browser's system-font rendering, which needs a canvas.
 */
function smiley(size = 96): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  const c = size / 2, r = size * 0.42;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c);
    if (d > r) continue;
    const eye = Math.hypot(x - c + r * 0.36, y - c + r * 0.25) < r * 0.13 || Math.hypot(x - c - r * 0.36, y - c + r * 0.25) < r * 0.13;
    const mouth = y > c + r * 0.15 && Math.abs(Math.hypot(x - c, y - c + r * 0.1) - r * 0.55) < r * 0.07;
    data.set(eye || mouth ? [70, 40, 20, 255] : [255, 205, 60, 255], (y * size + x) * 4);
  }
  return { width: size, height: size, data };
}
const emojiTarget = (raster = smiley()): Raster2DTarget => ({ kind: "raster2d", style: "emoji", raster });
const signal = () => new AbortController().signal;

// A. Tool definition

test("show_emoji: one canonical tool with a strict { emoji } schema, shared by both backends", () => {
  assert.equal(VISUAL_TOOL_NAMES.filter(name => name === "show_emoji").length, 1);
  const tools = visualTools.filter(tool => tool.name === "show_emoji");
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.deepEqual(tool.parameters.required, ["emoji"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["emoji"]);
  assert.equal(tool.parameters.properties.emoji.type, "string");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.match(tool.description, /no image search/);
  assert.match(tool.description, /never on every reply/);
  assert.ok(!visualTools.some(t => /^show_(smile|heart|rocket|party|emoji_)/.test(t.name)), "no per-emoji tools");
  // The same definitions object is registered on Realtime and on GPT-Live's Responses backend.
  assert.equal(buildSessionConfig(sessionOptionsFromEnv({})).tools, visualTools);
  assert.equal(buildLiveSessionConfig(liveOptionsFromEnv({})).delegation.responses.tools, visualTools);
  assert.deepEqual(SYMBOL_NAMES.length, 12, "the existing symbol vocabulary is kept");
});

// B, C. Validation

test("isSingleEmojiGrapheme accepts one emoji of any construction", () => {
  for (const value of ACCEPTED) assert.ok(isSingleEmojiGrapheme(value), `${value} ${[...value].map(c => c.codePointAt(0)!.toString(16)).join(" ")}`);
});

test("isSingleEmojiGrapheme rejects text, markup, URLs, control characters, several emoji and non-strings", () => {
  for (const value of REJECTED) assert.equal(isSingleEmojiGrapheme(value), false, JSON.stringify(value));
});

test("validateVisualAction: emoji actions are one validated grapheme and nothing else", () => {
  for (const value of ACCEPTED) assert.deepEqual(validateVisualAction({ type: "emoji", value }), { type: "emoji", value });
  for (const value of REJECTED) assert.equal(validateVisualAction({ type: "emoji", value }), null, JSON.stringify(value));
  assert.equal(validateVisualAction({ type: "emoji" }), null);
  assert.equal(validateVisualAction({ type: "emoji", value: "😊", url: "https://example.com" }), null);
});

// D, E. Tool mapping and executor

test("show_emoji maps onto { type: \"emoji\", value } through validateVisualAction()", () => {
  assert.deepEqual(toolCallToVisualAction("show_emoji", { emoji: "😊" }), { type: "emoji", value: "😊" });
  assert.deepEqual(toolCallToVisualAction("show_emoji", { emoji: " 👨‍🚀 " }), { type: "emoji", value: "👨‍🚀" }, "surrounding spaces are trimmed");
  assert.deepEqual(toolCallToVisualAction("show_emoji", { emoji: "🇬🇧" }), { type: "emoji", value: "🇬🇧" });
  for (const args of [{}, { emoji: "" }, { emoji: "hello" }, { emoji: "😊😂" }, { emoji: 1 }, { emoji: "😊", size: 3 }, { value: "😊" }]) {
    assert.equal(toolCallToVisualAction("show_emoji", args), null, JSON.stringify(args));
  }
});

test("executor: show_emoji reaches the body; invalid emoji never do", async () => {
  const submitted: VisualAction[] = [];
  const visual: VisualBody = { submit: async action => { submitted.push(action); return "queued"; }, lastFailure: null };
  const run = new ToolExecutor(visual, { budgetMs: 50, now: () => new Date(), timeZone: () => "UTC" });
  const shown = await run.execute("show_emoji", "{\"emoji\":\"🎉\"}");
  assert.deepEqual(shown.result, { ok: true, status: "displayed" });
  assert.deepEqual(shown.action, { type: "emoji", value: "🎉" });
  for (const raw of ["{\"emoji\":\"😊😂\"}", "{\"emoji\":\"<script>\"}", "{\"emoji\":\"https://example.com\"}", "{\"emoji\":\"\"}", "{}", "{\"emoji\":\"A\"}", "nope"]) {
    const result = await run.execute("show_emoji", raw);
    assert.deepEqual(result.result, { ok: false, status: "invalid-arguments" }, raw);
    assert.equal(result.action, null);
  }
  assert.deepEqual(submitted, [{ type: "emoji", value: "🎉" }]);
});

// F. Resolver

function offlineResolver(emoji: (value: string) => Raster) {
  const network: string[] = [];
  const request = (async (url: unknown) => { network.push(String(url)); throw new Error("no network in this test"); }) as typeof fetch;
  const images: ImageProvider = { name: "wikipedia", search: async query => { network.push(`image:${query}`); return []; } };
  const terrain: TerrainProvider = { name: "tiles", resolve: async region => { network.push(`terrain:${region}`); throw new Error("unused"); } };
  const resolver = new VisualResolver({
    imageProviders: [images], terrainProviders: [terrain], request,
    decodeImage: async () => { network.push("decode"); throw new Error("unused"); },
    glyphs: { text: () => { throw new Error("unused"); }, symbol: () => { throw new Error("unused"); }, emoji },
  });
  return { resolver, network };
}

test("resolver: an emoji is constructed locally as raster2d/emoji, with no provider chain and no network", async () => {
  const asked: string[] = [];
  const { resolver, network } = offlineResolver(value => { asked.push(value); return smiley(); });
  const target = await resolver.resolve({ type: "emoji", value: "😊" }, signal());
  assert.deepEqual(asked, ["😊"]);
  assert.deepEqual(network, [], "no image, terrain or fetch provider is consulted");
  assert.equal(target.visual.kind, "raster2d");
  assert.equal(target.visual.kind === "raster2d" && target.visual.style, "emoji");
  assert.equal(target.label, "😊");
  assert.equal(target.hold, HOLD_SECONDS.emoji);
  assert.ok(HOLD_SECONDS.emoji < HOLD_SECONDS.image && HOLD_SECONDS.emoji < HOLD_SECONDS.terrain, "an emoji is a brief gesture");
  const raster = target.visual.kind === "raster2d" ? target.visual.raster : null;
  let visible = 0;
  for (let i = 3; i < raster!.data.length; i += 4) if (raster!.data[i] > 128) visible++;
  assert.ok(visible > 1000, `visible pixels ${visible}`);
  const trace = resolver.lastTrace!;
  assert.equal(trace.action, "emoji");
  assert.equal(trace.query, "😊");
  assert.equal(trace.status, "resolved");
  assert.equal(trace.provider, "canvas");
  assert.equal(trace.sourceType, "constructed emoji");
  assert.equal(`${trace.targetType}/${trace.targetStyle}`, "raster2d/emoji");
  assert.equal(trace.fetchMs, 0);
  assert.deepEqual(trace.chain.map(step => step.provider), ["canvas"]);
});

test("resolver: an emoji no font can draw fails cleanly instead of forming an empty shape", async () => {
  const blank = (): Raster => ({ width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) });
  const { resolver, network } = offlineResolver(() => trimEmoji(blank()));
  await assert.rejects(resolver.resolve({ type: "emoji", value: "🫠" }, signal()), /^ResolveError: visual-unavailable$/);
  assert.equal(resolver.lastTrace!.status, "failed");
  assert.match(resolver.lastTrace!.error!, /emoji-unavailable/);
  assert.deepEqual(network, []);
  const transparent = offlineResolver(blank).resolver;
  await assert.rejects(transparent.resolve({ type: "emoji", value: "🫠" }, signal()), /^ResolveError: visual-unavailable$/, "the sampler rejects an empty raster too");
});

test("emoji rasters are trimmed to their ink and cached in a bounded, most-recently-used map", () => {
  // A 20×10 blob inside a 64×64 transparent canvas.
  const canvas: Raster = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
  for (let y = 30; y < 40; y++) for (let x = 10; x < 30; x++) canvas.data.set([255, 0, 0, 255], (y * 64 + x) * 4);
  const trimmed = trimTransparent(canvas, 8, 0.05)!;
  assert.deepEqual([trimmed.width, trimmed.height], [22, 12], "the ink plus a 1 px margin (5% of 20)");
  assert.equal(trimTransparent({ width: 4, height: 4, data: new Uint8ClampedArray(64) }), null);
  assert.throws(() => trimEmoji({ width: 4, height: 4, data: new Uint8ClampedArray(64) }), /emoji-unavailable/);

  const rendered: string[] = [];
  const rasterize = createEmojiRasterizer(emoji => { rendered.push(emoji); return canvas; }, 2);
  const first = rasterize("😊");
  assert.equal(rasterize("😊"), first, "a repeat is served from memory");
  rasterize("🎉");
  rasterize("😊"); // 😊 is now the most recently used
  rasterize("🚀"); // evicts 🎉
  assert.deepEqual([...rasterize.cache.keys()], ["😊", "🚀"]);
  rasterize("🎉");
  assert.deepEqual(rendered, ["😊", "🎉", "🚀", "🎉"]);
  assert.equal(rasterize.cache.size, 2, "the cache never grows past its bound");
});

// G. Particle sampler

test("emoji sampling: deterministic, finite, bounded, a shallow slab, nothing from transparency", () => {
  const raster = smiley();
  const a = createTargetPoints(emojiTarget(raster), 6000), b = createTargetPoints(emojiTarget(raster), 6000);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.tones, b.tones);
  // Every quality tier is a prefix of the same arrangement.
  assert.deepEqual(createTargetPoints(emojiTarget(raster), 2000).positions, a.positions.subarray(0, 6000));
  let maxX = 0, maxY = 0, maxZ = 0, outside = 0;
  const c = raster.width / 2, r = raster.width * 0.42, w = 2.5;
  for (let i = 0; i < 6000; i++) {
    const [x, y, z] = a.positions.subarray(i * 3, i * 3 + 3);
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    assert.ok(Number.isFinite(a.tones[i]) && a.tones[i] >= 0 && a.tones[i] <= 1, `tone ${a.tones[i]}`);
    maxX = Math.max(maxX, Math.abs(x)); maxY = Math.max(maxY, Math.abs(y)); maxZ = Math.max(maxZ, Math.abs(z));
    // Back to source pixels: every particle lies on the opaque disc (within a pixel of jitter).
    const px = (x / w + 0.5) * raster.width, py = (0.5 - y / w) * raster.height;
    if (Math.hypot(px - c, py - c) > r + 1.5) outside++;
  }
  assert.equal(outside, 0, "no particles from transparent pixels: no background box");
  assert.ok(maxX <= 1.25 && maxY <= 1.25 && maxX > 0.9 && maxY > 0.9, `xy extent ${maxX} ${maxY}`);
  assert.ok(maxZ < 0.1, `z depth ${maxZ}`);
  const empty: Raster = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) };
  assert.throws(() => createTargetPoints(emojiTarget(empty), 100), /empty-raster/);
});

test("emoji sampling keeps inner features: eyes and mouth are denser than flat face, and read darker", () => {
  const raster = smiley();
  const { positions, tones } = createTargetPoints(emojiTarget(raster), 20000);
  const c = raster.width / 2, r = raster.width * 0.42, w = 2.5;
  const eye = { x: c - r * 0.36, y: c - r * 0.25 }, cheek = { x: c + r * 0.5, y: c + r * 0.05 };
  let nearEye = 0, nearCheek = 0, eyeTone = 0, eyeInside = 0, faceTone = 0, face = 0;
  for (let i = 0; i < 20000; i++) {
    const px = (positions[i * 3] / w + 0.5) * raster.width, py = (0.5 - positions[i * 3 + 1] / w) * raster.height;
    const de = Math.hypot(px - eye.x, py - eye.y);
    if (de < r * 0.2) nearEye++;
    if (Math.hypot(px - cheek.x, py - cheek.y) < r * 0.2) nearCheek++;
    if (de < r * 0.08) { eyeTone += tones[i]; eyeInside++; }
    if (Math.hypot(px - cheek.x, py - cheek.y) < r * 0.15) { faceTone += tones[i]; face++; }
  }
  assert.ok(nearEye > nearCheek * 1.5, `eye ${nearEye} vs flat cheek ${nearCheek}: inner edges are emphasized`);
  assert.ok(nearCheek > 50, `flat areas still get particles (${nearCheek})`);
  assert.ok(eyeTone / eyeInside < faceTone / face - 0.2, "dark features read darker than the face");
});

test("emoji sampling is its own style: not the portrait, object, glyph or logo arrangement", () => {
  const raster = smiley();
  const emoji = createTargetPoints(emojiTarget(raster), 3000);
  for (const style of ["portrait", "object", "glyph", "logo"] as const) {
    const other = createTargetPoints({ kind: "raster2d", style, raster }, 3000);
    assert.notDeepEqual(emoji.positions, other.positions, style);
  }
  // Portrait sampling of a transparent-background raster spreads particles with a vignette; emoji
  // sampling has none: it keeps the full silhouette out to the rim.
  let rim = 0;
  const c = raster.width / 2, r = raster.width * 0.42, w = 2.5;
  for (let i = 0; i < 3000; i++) {
    const px = (emoji.positions[i * 3] / w + 0.5) * raster.width, py = (0.5 - emoji.positions[i * 3 + 1] / w) * raster.height;
    if (Math.hypot(px - c, py - c) > r - 3) rim++;
  }
  assert.ok(rim > 3000 * 0.08, `the outline is emphasized (${rim} rim particles)`);
});

// H. Lifecycle

test("lifecycle: sphere → emoji → sphere, returning on its own after a brief hold", async () => {
  const { resolver } = offlineResolver(() => smiley());
  const controller = new VisualActionController(resolver.resolve);
  const run = new ToolExecutor(controller, { budgetMs: 200, now: () => new Date(), timeZone: () => "UTC" });
  assert.equal(controller.phase, "sphere");
  assert.deepEqual((await run.execute("show_emoji", "{\"emoji\":\"😊\"}")).result, { ok: true, status: "displayed" });
  const phases = new Set<string>();
  let seconds = 0;
  for (; seconds < 12; seconds += 1 / 60) {
    controller.sample(1 / 60);
    phases.add(controller.phase);
    if (seconds > 1 && controller.phase === "sphere") break;
  }
  assert.deepEqual([...phases], ["forming", "holding", "returning", "sphere"]);
  assert.equal(controller.level, 0);
  assert.equal(controller.target?.visual.kind === "raster2d" && controller.target.visual.style, "emoji");
  assert.ok(seconds < 1.6 + HOLD_SECONDS.emoji + 1.3 + 0.2, `back to the sphere after ${seconds.toFixed(2)} s`);
});

// I. Shared prompts

test("both backends reason with the same emoji guidance", () => {
  assert.match(VISUAL_TOOL_RULES, /show_emoji/);
  assert.match(VISUAL_TOOL_RULES, /never on every reply/);
  assert.match(VISUAL_TOOL_RULES, /Never use it instead of an image, portrait, terrain/);
  assert.match(VISUAL_TOOL_RULES, /Call at most one visual tool per reply/);
  assert.ok(PRESENCE_INSTRUCTIONS.includes(VISUAL_TOOL_RULES), "Realtime");
  assert.ok(LIVE_BACKEND_INSTRUCTIONS.includes(VISUAL_TOOL_RULES), "GPT-Live Responses backend");
  assert.match(LIVE_VOICE_INSTRUCTIONS, /emoji/, "the live voice knows it can delegate an emoji");
});

import test from "node:test";
import assert from "node:assert/strict";
import { FORM_SAMPLES } from "../src/dev/formSamples";
import { LIVE_BACKEND_INSTRUCTIONS, LIVE_VOICE_INSTRUCTIONS } from "../src/live/instructions";
import { buildLiveSessionConfig, liveOptionsFromEnv } from "../src/live/session";
import { PRESENCE_INSTRUCTIONS } from "../src/realtime/instructions";
import { buildSessionConfig, sessionOptionsFromEnv } from "../src/realtime/session";
import { VisualActionController } from "../src/visual-actions/controller";
import { HOLD_SECONDS, SYMBOL_NAMES, type VisualAction } from "../src/visual-actions/types";
import { validateVisualAction } from "../src/visual-actions/validate";
import { FORM_ID, normalizeFormName, VISUAL_FORM_PACKS, VisualFormRegistry, visualForms, type VisualFormEntry, type VisualFormPack } from "../src/visual-forms";
import { PLANETS, ZODIAC_SIGNS } from "../src/visual-forms/celestial/astrology/glyphs";
import { dec, ra } from "../src/visual-forms/celestial/astronomy/catalog";
import { CONSTELLATIONS, ORION } from "../src/visual-forms/celestial/astronomy/constellations";
import { CHART_EXTENT, chart } from "../src/visual-forms/celestial/astronomy/projection";
import { renderStarMap } from "../src/visual-forms/celestial/astronomy/starMap";
import { renderTrigram, renderYinYang } from "../src/visual-forms/tao/draw";
import { BAGUA_ARRANGEMENTS, TRIGRAM_ORDER, TRIGRAMS } from "../src/visual-forms/tao/trigrams";
import { createTargetPoints, pointLayoutLimits } from "../src/visual-resolver/points";
import { VisualResolver } from "../src/visual-resolver/resolve";
import type { PointLayoutTarget, Raster, Raster2DTarget, VisualTarget } from "../src/visual-resolver/types";
import { VISUAL_TOOL_NAMES, visualTools } from "../src/voice/tools/definitions";
import { resolveFormArguments, toolCallToVisualAction, ToolExecutor } from "../src/voice/tools/executor";
import { VISUAL_TOOL_RULES } from "../src/voice/visualGuidance";

const noop = () => { throw new Error("not used"); };
/** The real resolver, with every network provider absent: forms must never need one. */
const resolver = () => new VisualResolver({
  imageProviders: [], terrainProviders: [], decodeImage: noop,
  glyphs: { text: noop, symbol: noop, emoji: noop },
});
const density = (raster: Raster, x: number, y: number) => raster.data[(Math.round(y) * raster.width + Math.round(x)) * 4 + 3] / 255;

// Registry

test("registry: every form has a well-formed, category-prefixed id and a label, and ids are unique", () => {
  const ids = visualForms.ids();
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 38, `${ids.length} forms`);
  for (const form of visualForms.forms()) {
    assert.match(form.id, FORM_ID);
    assert.ok(form.id.startsWith(`${form.category}.`), form.id);
    assert.ok(visualForms.category(form.category), form.category);
    assert.ok(form.label.trim(), form.id);
  }
  for (const id of ["tao.yin-yang", "tao.yin-line", "tao.yang-line", "tao.qian", "tao.dui", "tao.li", "tao.zhen", "tao.xun", "tao.kan",
    "tao.gen", "tao.kun", "tao.bagua", "astronomy.orion", "astronomy.ursa-major", "astronomy.cassiopeia", "astronomy.scorpius",
    "astronomy.leo", "astronomy.cygnus", "astronomy.pleiades", ...ZODIAC_SIGNS.map(sign => `astrology.${sign}`), ...PLANETS.map(p => `astrology.${p}`)]) {
    assert.ok(visualForms.has(id), id);
  }
  assert.deepEqual(visualForms.categories().map(category => [category.id, category.family]),
    [["tao", "tao"], ["astronomy", "celestial"], ["astrology", "celestial"]], "astronomy and astrology stay separate categories");
});

test("registry lookup: ids, aliases in English, Chinese and symbols, and category hints", () => {
  const found = (query: string) => { const match = visualForms.lookup(query); return match && (match.variant ? `${match.entry.id}#${match.variant}` : match.entry.id); };
  const cases: [string, string][] = [
    ["tao.yin-yang", "tao.yin-yang"], ["ASTRONOMY.ORION", "astronomy.orion"],
    ["yin yang", "tao.yin-yang"], ["Yin–Yang", "tao.yin-yang"], ["taiji", "tao.yin-yang"], ["太极", "tao.yin-yang"], ["阴阳", "tao.yin-yang"], ["☯", "tao.yin-yang"],
    ["Qian", "tao.qian"], ["qián", "tao.qian"], ["乾", "tao.qian"], ["乾卦", "tao.qian"], ["☰", "tao.qian"],
    ["兑", "tao.dui"], ["兌", "tao.dui"], ["离", "tao.li"], ["離", "tao.li"], ["震", "tao.zhen"], ["巽", "tao.xun"], ["坎", "tao.kan"], ["艮", "tao.gen"], ["坤", "tao.kun"],
    ["fire trigram", "tao.li"], ["the trigram of water", "tao.kan"], ["Kun trigram", "tao.kun"],
    ["the Eight Trigrams", "tao.bagua"], ["八卦", "tao.bagua"], ["bagua", "tao.bagua"], ["后天八卦", "tao.bagua#later-heaven"], ["先天八卦", "tao.bagua#earlier-heaven"],
    ["Orion", "astronomy.orion"], ["猎户座", "astronomy.orion"], ["the Pleiades", "astronomy.pleiades"], ["Seven Sisters", "astronomy.pleiades"],
    ["Big Dipper", "astronomy.ursa-major"], ["Ursa Major", "astronomy.ursa-major"], ["Northern Cross", "astronomy.cygnus"],
    ["Leo", "astrology.leo"], ["Leo constellation", "astronomy.leo"], ["the constellation of Leo", "astronomy.leo"], ["the Leo zodiac sign", "astrology.leo"],
    ["Scorpio", "astrology.scorpio"], ["Scorpius", "astronomy.scorpius"], ["Scorpio constellation", "astronomy.scorpius"],
    ["Aries", "astrology.aries"], ["Aries zodiac sign", "astrology.aries"], ["sign of the ram", "astrology.aries"], ["♈", "astrology.aries"], ["♈️", "astrology.aries"],
    ["白羊座", "astrology.aries"], ["双鱼座", "astrology.pisces"], ["Venus symbol", "astrology.venus"], ["planet Mars", "astrology.mars"], ["♄", "astrology.saturn"],
  ];
  for (const [query, id] of cases) assert.equal(found(query), id, query);
});

test("registry lookup: ordinary words, unknown names and bad input find nothing", () => {
  for (const query of ["fish", "fire", "ram", "lion", "car", "Tesla Model Y", "", "   ", "x".repeat(61), "tao.unknown", "astronomy.andromeda", "zodiac", "constellation"]) {
    assert.equal(visualForms.lookup(query), null, JSON.stringify(query));
  }
  assert.equal(visualForms.lookup(42 as unknown as string), null);
  assert.equal(normalizeFormName("  Orion’s   Belt! "), "orion belt");
  assert.equal(normalizeFormName("Qián"), "qian");
});

test("registry: duplicate ids, alias or term collisions, malformed ids and unknown categories are rejected", () => {
  const category = { id: "demo", family: "demo", label: "Demo", hints: ["demo"] };
  const form = (id: string, aliases: string[] = [], extra: Partial<VisualFormEntry> = {}): VisualFormEntry =>
    ({ id, category: "demo", renderer: "test", label: id, aliases, render: noop, ...extra });
  const pack = (...forms: VisualFormEntry[]): VisualFormPack => ({ id: "demo", categories: [category], forms });
  assert.equal(new VisualFormRegistry([pack(form("demo.a", ["alpha"]), form("demo.b", ["beta"]))]).size, 2);
  assert.throws(() => new VisualFormRegistry([pack(form("demo.a"), form("demo.a"))]), /id-duplicate/);
  assert.throws(() => new VisualFormRegistry([pack(form("demo.a", ["Alpha"]), form("demo.b", ["alpha"]))]), /alias-collision/);
  assert.throws(() => new VisualFormRegistry([pack(form("demo.a", [], { terms: ["x"] }), form("demo.b", [], { terms: ["X"] }))]), /term-collision/);
  assert.throws(() => new VisualFormRegistry([pack(form("Demo.A"))]), /id-invalid/);
  assert.throws(() => new VisualFormRegistry([pack(form("other.a"))]), /category-unknown/);
  assert.throws(() => new VisualFormRegistry([pack(form("demo.a", ["   "]))]), /alias-empty/);
  assert.throws(() => new VisualFormRegistry([pack(form("demo.a", [], { variants: [{ id: "x", label: "x" }, { id: "x", label: "y" }] }))]), /variant-invalid/);
  assert.throws(() => new VisualFormRegistry([pack(form("demo.a")), pack(form("demo.b"))]), /category-invalid/, "a category is registered once");
  // The shipped packs register cleanly into a fresh registry (no collisions between them).
  assert.equal(new VisualFormRegistry(VISUAL_FORM_PACKS).size, visualForms.size);
});

test("registry: rendering is deterministic and cached; variants are only the declared ones", () => {
  const fresh = new VisualFormRegistry(VISUAL_FORM_PACKS);
  const a = fresh.render("tao.yin-yang"), b = fresh.render("tao.yin-yang");
  assert.equal(a, b, "cached");
  const c = new VisualFormRegistry(VISUAL_FORM_PACKS).render("tao.yin-yang");
  assert.deepEqual((c.visual as Raster2DTarget).raster.data, (a.visual as Raster2DTarget).raster.data, "the same drawing every time");
  assert.equal(fresh.render("tao.bagua", "later-heaven").variant, "later-heaven");
  assert.equal(fresh.render("tao.bagua", "nonsense").variant, undefined);
  assert.throws(() => fresh.render("tao.nothing"), /form-not-found/);
  assert.equal(fresh.label("tao.bagua", "later-heaven"), "Bagua (八卦) · Later Heaven (后天八卦, King Wen)");
});

// Every form renders into a valid target

test("every registered form renders a non-empty, valid target that the particle sampler accepts", () => {
  for (const form of visualForms.forms()) {
    for (const variant of [undefined, ...(form.variants ?? []).map(item => item.id)]) {
      const rendered = visualForms.render(form.id, variant);
      const points = createTargetPoints(rendered.visual, 3000);
      assert.equal(points.positions.length, 9000, form.id);
      for (let i = 0; i < points.positions.length; i++) assert.ok(Number.isFinite(points.positions[i]), `${form.id} position`);
      for (let i = 0; i < 3000; i++) {
        assert.ok(points.tones[i] >= 0 && points.tones[i] <= 1, `${form.id} tone`);
        assert.ok(Math.abs(points.positions[i * 3]) <= 2.2 && Math.abs(points.positions[i * 3 + 1]) <= 2.2, `${form.id} stays on stage`);
      }
      if (rendered.visual.kind === "raster2d") assert.equal(rendered.visual.style, "ink");
      else assert.equal(rendered.visual.kind, "points");
    }
  }
});

// Tao

test("tao: the eight trigrams are the eight distinct three-line structures, in Unicode's order", () => {
  const seen = new Set<string>();
  TRIGRAM_ORDER.forEach((name, index) => {
    const { lines, symbol } = TRIGRAMS[name];
    assert.equal(lines.length, 3);
    seen.add(lines.join(""));
    // U+2630 + (bottom yin × 4 + middle yin × 2 + top yin): ☰ qian … ☷ kun.
    const code = 0x2630 + (1 - lines[0]) * 4 + (1 - lines[1]) * 2 + (1 - lines[2]);
    assert.equal(symbol, String.fromCodePoint(code), name);
    assert.equal(symbol.codePointAt(0), 0x2630 + index, name);
  });
  assert.equal(seen.size, 8);
  assert.deepEqual(TRIGRAMS.qian.lines, [1, 1, 1]);
  assert.deepEqual(TRIGRAMS.kun.lines, [0, 0, 0]);
  assert.deepEqual(TRIGRAMS.zhen.lines, [1, 0, 0], "thunder: one yang line at the bottom");
  assert.deepEqual(TRIGRAMS.gen.lines, [0, 0, 1], "mountain: one yang line at the top");
});

/** Reads a rendered trigram back from its pixels: for each line from the bottom up, the number of bars across it. */
function readTrigram(raster: Raster): number[] {
  const bands: number[] = [];
  let inside = false;
  for (let y = 0; y < raster.height; y++) {
    const on = density(raster, raster.width * 0.25, y) > 0.5;
    if (on && !inside) bands.push(y);
    inside = on;
  }
  return bands.reverse().map(top => {
    let runs = 0, on = false;
    for (let x = 0; x < raster.width; x++) {
      const now = density(raster, x, top + 4) > 0.5;
      if (now && !on) runs++;
      on = now;
    }
    return runs;
  });
}

test("tao: each rendered trigram shows its three lines, bottom to top, with one bar for yang and two for yin", () => {
  for (const name of TRIGRAM_ORDER) {
    const target = renderTrigram(name);
    assert.equal(target.style, "ink");
    assert.deepEqual(readTrigram(target.raster), TRIGRAMS[name].lines.map(line => line === 1 ? 1 : 2), name);
  }
  const yin = visualForms.render("tao.yin-line").visual as Raster2DTarget, yang = visualForms.render("tao.yang-line").visual as Raster2DTarget;
  const runs = (raster: Raster) => { let count = 0, on = false; for (let x = 0; x < raster.width; x++) { const now = density(raster, x, raster.height / 2) > 0.5; if (now && !on) count++; on = now; } return count; };
  assert.equal(runs(yin.raster), 2);
  assert.equal(runs(yang.raster), 1);
});

test("tao: the yin-yang is centred, balanced, S-divided, with a dot of each in the other", () => {
  const { raster } = renderYinYang();
  const { width, height } = raster;
  assert.equal(width, height);
  const c = (width - 1) / 2, r = 0.92 * width / 2;
  // The silhouette (all ink) is a centred disc.
  let left = width, right = 0, top = height, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (density(raster, x, y) > 0.05) {
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  assert.ok(Math.abs((left + right) / 2 - c) <= 1 && Math.abs((top + bottom) / 2 - c) <= 1, "centred");
  assert.ok(Math.abs((right - left) - (bottom - top)) <= 2, "round");
  // Yang (bright, dense) and yin (a sparse wash) are point reflections of each other: equal halves.
  let yang = 0, yin = 0, mirrored = 0, checked = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x - c, dy = y - c;
    if (Math.hypot(dx, dy) > r * 0.9) continue;
    const bright = density(raster, x, y) > 0.6;
    if (bright) yang++; else yin++;
    checked++;
    if (bright !== (density(raster, c - dx, c - dy) > 0.6)) mirrored++;
  }
  assert.ok(Math.abs(yang - yin) / checked < 0.03, `balanced ${yang} / ${yin}`);
  assert.ok(mirrored / checked > 0.95, "each half is the other turned by 180°");
  // Left of centre is yang, right is yin; the S bends through the centre; each head holds the opposite dot.
  const at = (fx: number, fy: number) => density(raster, c + fx * r, c - fy * r);
  assert.ok(at(-0.7, 0) > 0.8 && at(0.7, 0) < 0.3, "yang left, yin right");
  assert.ok(at(0.25, 0.5) > 0.8 && at(-0.25, -0.5) < 0.3, "the heads swell across the middle: an S, not a straight cut");
  assert.ok(at(0, 0.5) < 0.3, "yin dot in the yang head");
  assert.ok(at(0, -0.5) > 0.8, "yang dot in the yin head");
  assert.ok(at(0.99, 0) > 0.5, "a rim keeps the silhouette whole on the yin side");
  // The particle body is centred too.
  const points = createTargetPoints({ kind: "raster2d", style: "ink", raster }, 6000);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 6000; i++) {
    minX = Math.min(minX, points.positions[i * 3]); maxX = Math.max(maxX, points.positions[i * 3]);
    minY = Math.min(minY, points.positions[i * 3 + 1]); maxY = Math.max(maxY, points.positions[i * 3 + 1]);
  }
  assert.ok(Math.abs(minX + maxX) < 0.05 && Math.abs(minY + maxY) < 0.05, "particles centred on the stage");
  assert.ok(maxX - minX > 2.4, "a strong, large silhouette");
});

test("tao: both bagua arrangements place all eight trigrams once, with the bottom line toward the centre", () => {
  for (const arrangement of Object.values(BAGUA_ARRANGEMENTS)) assert.deepEqual(new Set(Object.values(arrangement)).size, 8);
  // Earlier Heaven: every trigram faces its complement across the centre.
  const earlier = BAGUA_ARRANGEMENTS["earlier-heaven"];
  for (const [a, b] of [["S", "N"], ["E", "W"], ["SE", "NW"], ["NE", "SW"]] as const) {
    assert.deepEqual(TRIGRAMS[earlier[a]].lines.map((line, i) => line + TRIGRAMS[earlier[b]].lines[i]), [1, 1, 1], `${a}/${b}`);
  }
  assert.equal(BAGUA_ARRANGEMENTS["later-heaven"].S, "li");
  assert.equal(BAGUA_ARRANGEMENTS["later-heaven"].N, "kan");
  // Read the drawing: straight up (south) is Qian, three whole lines; straight down (north) is Kun, broken at every line.
  const { raster } = visualForms.render("tao.bagua").visual as Raster2DTarget;
  const c = (raster.width - 1) / 2, unit = raster.width / 2;
  for (const radius of [0.56, 0.69, 0.82]) {
    assert.ok(density(raster, c, c - radius * unit) > 0.8, `qian line at ${radius}`);
    assert.ok(density(raster, c, c + radius * unit) < 0.2, `kun gap at ${radius}`);
  }
  const later = visualForms.render("tao.bagua", "later-heaven").visual as Raster2DTarget;
  assert.ok(density(later.raster, c, c - 0.69 * unit) < 0.2, "Later Heaven puts Li (a broken middle line) at the top");
});

test("tao: forms are calm: slower transitions, and the yin-yang and bagua turn slowly while trigrams stay upright", () => {
  const yinYang = visualForms.render("tao.yin-yang"), qian = visualForms.render("tao.qian"), bagua = visualForms.render("tao.bagua");
  assert.ok(yinYang.spin! < 0 && Math.abs(yinYang.spin!) < 0.3, "a slow clockwise turn");
  assert.ok(bagua.spin! < 0 && Math.abs(bagua.spin!) < Math.abs(yinYang.spin!));
  assert.equal(qian.spin, undefined, "a trigram's orientation carries its meaning");
  assert.ok(yinYang.transition!.form! > 1.6, "forms more slowly than information");
});

// Celestial: astronomy

test("astronomy: catalogue coordinates parse, including negative declinations near zero", () => {
  assert.ok(Math.abs(ra("05 55 10.31") - 88.793) < 0.001);
  assert.ok(Math.abs(dec("-00 17 56.7") + 0.2991) < 0.001);
  assert.ok(Math.abs(dec("+61 45 03.7") - 61.751) < 0.001);
  assert.throws(() => ra("25 00 00"));
  assert.throws(() => dec("+95 00 00"));
});

test("astronomy: constellation data is consistent and normalizes into the shared frame", () => {
  for (const data of CONSTELLATIONS) {
    const ids = new Set(data.stars.map(item => item.id));
    assert.equal(ids.size, data.stars.length, data.id);
    for (const [a, b] of data.lines) assert.ok(ids.has(a) && ids.has(b) && a !== b, `${data.id}: ${a}–${b}`);
    for (const item of data.stars) assert.ok(item.mag > -2 && item.mag < 7 && item.ra >= 0 && item.ra < 360 && Math.abs(item.dec) <= 90, item.name);
    const { points } = chart(data.stars);
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const halfW = (Math.max(...xs) - Math.min(...xs)) / 2, halfH = (Math.max(...ys) - Math.min(...ys)) / 2;
    assert.ok(Math.abs(Math.max(halfW, halfH) - CHART_EXTENT) < 1e-9, `${data.id} fills the frame`);
    assert.ok(Math.abs(Math.max(...xs) + Math.min(...xs)) < 1e-9 && Math.abs(Math.max(...ys) + Math.min(...ys)) < 1e-9, `${data.id} centred`);
    const target = renderStarMap(data);
    for (const p of target.layout.points) assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, data.id);
  }
});

test("astronomy: Orion keeps its recognizable structure (sky orientation, belt, brightest stars)", () => {
  const { points } = chart(ORION.stars);
  const at = (id: string) => points[ORION.stars.findIndex(item => item.id === id)];
  const [betelgeuse, rigel, bellatrix, saiph] = ["betelgeuse", "rigel", "bellatrix", "saiph"].map(at);
  assert.ok(betelgeuse.x < rigel.x && betelgeuse.y > rigel.y, "Betelgeuse upper left, Rigel lower right (east is left)");
  assert.ok(betelgeuse.x < bellatrix.x && saiph.x < rigel.x, "shoulders and knees in sky order");
  // The belt: three nearly collinear stars between shoulders and knees, in order.
  const [mintaka, alnilam, alnitak] = ["mintaka", "alnilam", "alnitak"].map(at);
  assert.ok(mintaka.x > alnilam.x && alnilam.x > alnitak.x);
  const cross = (alnilam.x - mintaka.x) * (alnitak.y - mintaka.y) - (alnilam.y - mintaka.y) * (alnitak.x - mintaka.x);
  assert.ok(Math.abs(cross) / Math.hypot(alnitak.x - mintaka.x, alnitak.y - mintaka.y) ** 2 < 0.1, "collinear belt");
  assert.ok(alnilam.y < bellatrix.y && alnilam.y > rigel.y);
  // Brighter stars draw more particles: Rigel (0.1 mag) outshines χ² Ori (4.6 mag), an isolated faint star.
  const target = renderStarMap(ORION);
  const count = 20_000, { positions } = createTargetPoints(target, count), scale = pointLayoutLimits.scale;
  const near = (p: { x: number; y: number }) => {
    let n = 0;
    for (let i = 0; i < count; i++) if (Math.hypot(positions[i * 3] / scale - p.x, positions[i * 3 + 1] / scale - p.y) < 0.04) n++;
    return n;
  };
  assert.ok(near(rigel) > near(at("chi2")) * 3, "magnitude sets prominence");
  const rigelPoint = target.layout.points[ORION.stars.findIndex(item => item.id === "rigel")];
  const faintPoint = target.layout.points[ORION.stars.findIndex(item => item.id === "chi2")];
  assert.ok(rigelPoint.radius > faintPoint.radius && rigelPoint.tone > faintPoint.tone);
  // Lines are subtle and optional.
  assert.ok(target.layout.strokes.length > 5 && target.layout.strokes.every(stroke => stroke.tone < 0.5));
  assert.equal((visualForms.render("astronomy.orion", "stars").visual as PointLayoutTarget).layout.strokes.length, 0);
  assert.equal((visualForms.render("astronomy.pleiades").visual as PointLayoutTarget).layout.strokes.length, 0, "a cluster has no figure");
});

// Celestial: astrology

test("astrology: all twelve zodiac signs and the planetary symbols render as star-drawn glyphs", () => {
  const shapes = new Set<string>();
  for (const id of [...ZODIAC_SIGNS, ...PLANETS].map(name => `astrology.${name}`)) {
    const { visual } = visualForms.render(id);
    assert.equal(visual.kind, "points", id);
    const { layout } = visual as PointLayoutTarget;
    assert.ok(layout.strokes.length >= 1, id);
    let extent = 0;
    for (const stroke of layout.strokes) for (const value of stroke.points) extent = Math.max(extent, Math.abs(value));
    assert.ok(extent > 0.8 && extent <= 0.85, `${id} is normalized (${extent})`);
    shapes.add(JSON.stringify(layout.strokes.map(stroke => stroke.points.map(value => value.toFixed(2)))));
  }
  assert.equal(shapes.size, ZODIAC_SIGNS.length + PLANETS.length, "every glyph is its own shape");
  assert.match(visualForms.label("astrology.aries"), /Aries ♈/);
});

test("point layouts: quality prefixes, and malformed layouts are rejected before the render loop", () => {
  const target = visualForms.render("astronomy.cassiopeia").visual as PointLayoutTarget;
  const large = createTargetPoints(target, 4000), small = createTargetPoints(target, 1000);
  assert.deepEqual(large.positions.slice(0, 3000), small.positions);
  const bad = (layout: Partial<PointLayoutTarget["layout"]>): VisualTarget => ({ kind: "points", style: "celestial", layout: { ...target.layout, ...layout } });
  for (const layout of [
    { dust: 0.9 }, { points: [], strokes: [] }, { points: [{ x: NaN, y: 0, weight: 1, radius: 0.1, tone: 1 }] },
    { points: [{ x: 3, y: 0, weight: 1, radius: 0.1, tone: 1 }] }, { strokes: [{ points: [0, 0, 1], width: 0.1, weight: 1, tone: 1 }] },
    { strokes: [{ points: [0, 0, 0.5, 0.5], width: 2, weight: 1, tone: 1 }] },
    { points: Array.from({ length: pointLayoutLimits.points + 1 }, () => ({ x: 0, y: 0, weight: 1, radius: 0.1, tone: 1 })) },
  ]) assert.throws(() => createTargetPoints(bad(layout), 10), JSON.stringify(layout).slice(0, 60));
});

// show_form: validation, the executor and the canonical tool path

test("show_form: names and ids map onto one canonical form action; variants are hints", () => {
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "tao.yin-yang" }), { type: "form", form: "tao.yin-yang" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: " Yin Yang " }), { type: "form", form: "tao.yin-yang" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "Orion" }), { type: "form", form: "astronomy.orion" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "Leo zodiac sign" }), { type: "form", form: "astrology.leo" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "tao.bagua", variant: "later-heaven" }), { type: "form", form: "tao.bagua", variant: "later-heaven" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "bagua", variant: "King Wen" }), { type: "form", form: "tao.bagua", variant: "later-heaven" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "后天八卦" }), { type: "form", form: "tao.bagua", variant: "later-heaven" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "tao.bagua", variant: "sideways" }), { type: "form", form: "tao.bagua" }, "an unknown variant is only a hint");
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "orion", variant: "stars" }), { type: "form", form: "astronomy.orion", variant: "stars" });
  assert.deepEqual(toolCallToVisualAction("show_form", { form: "tao.qian", variant: null }), { type: "form", form: "tao.qian" });
});

test("show_form: malformed arguments are invalid; well-formed unknown names are not found", () => {
  const invalid: Record<string, unknown>[] = [
    {}, { form: "" }, { form: 42 }, { form: "x".repeat(61) }, { form: "<script>" }, { form: "https://evil.test/yin.png" },
    { form: "tao.qian", color: "red" }, { form: "tao.qian", variant: 3 }, { form: "bad‮text" }, { form: "a\u0000b" },
  ];
  for (const args of invalid) {
    assert.equal(toolCallToVisualAction("show_form", args), null, JSON.stringify(args));
    assert.equal(resolveFormArguments(args).status, "invalid", JSON.stringify(args));
  }
  for (const form of ["Andromeda Galaxy", "car", "tao.nothing", "fish"]) assert.equal(resolveFormArguments({ form }).status, "not-found", form);
});

test("validateVisualAction: form actions accept only registered ids and their declared variants", () => {
  assert.deepEqual(validateVisualAction({ type: "form", form: "tao.qian" }), { type: "form", form: "tao.qian" });
  assert.deepEqual(validateVisualAction({ type: "form", form: "astronomy.leo", variant: "stars" }), { type: "form", form: "astronomy.leo", variant: "stars" });
  for (const value of [
    { type: "form" }, { type: "form", form: "yin yang" }, { type: "form", form: "tao.nothing" }, { type: "form", form: "TAO.QIAN" },
    { type: "form", form: "tao.qian", variant: "stars" }, { type: "form", form: "tao.bagua", variant: "sideways" },
    { type: "form", form: "tao.qian", url: "https://evil.test" }, { type: "form", form: ["tao.qian"] },
  ]) assert.equal(validateVisualAction(value), null, JSON.stringify(value));
  assert.equal(HOLD_SECONDS.form, 10);
});

test("executor: show_form through the real controller and resolver forms the body without any network, then returns", async () => {
  const visual = new VisualActionController(resolver().resolve);
  const run = new ToolExecutor(visual, { budgetMs: 500, now: () => new Date(), timeZone: () => "UTC" });
  const shown = await run.execute("show_form", JSON.stringify({ form: "yin yang" }));
  assert.deepEqual(shown.action, { type: "form", form: "tao.yin-yang" });
  assert.deepEqual(shown.result, { ok: true, status: "displayed", shown: "Yin-yang ☯ (太极)" });
  for (let i = 0; i < 60 * 3; i++) visual.sample(1 / 60);
  assert.equal(visual.phase, "holding");
  assert.equal(visual.target?.label, "Yin-yang ☯ (太极)");
  assert.equal(visual.target?.visual.kind, "raster2d");
  assert.ok(visual.target?.motion?.spin, "the yin-yang turns slowly while held");
  assert.equal(visual.target?.hold, HOLD_SECONDS.form);
  // A second form replaces the first through the sphere; the result names what a name resolved to.
  const leo = await run.execute("show_form", JSON.stringify({ form: "Leo constellation" }));
  assert.deepEqual(leo.result, { ok: true, status: "displayed", shown: "Leo (constellation)" });
  for (let i = 0; i < 60 * 6; i++) visual.sample(1 / 60);
  assert.equal(visual.target?.visual.kind, "points");
  assert.equal(visual.target?.motion, undefined);
  assert.equal(visual.phase, "holding");
  assert.equal((await run.execute("return_to_sphere", "{}")).result.status, "returning");
  for (let i = 0; i < 60 * 3; i++) visual.sample(1 / 60);
  assert.equal(visual.phase, "sphere");
  assert.equal(visual.level, 0);
});

test("executor: unknown forms and bad arguments never touch the body", async () => {
  const submitted: VisualAction[] = [];
  const run = new ToolExecutor({ submit: async action => { submitted.push(action); return "queued"; }, lastFailure: null },
    { budgetMs: 50, now: () => new Date(), timeZone: () => "UTC" });
  assert.deepEqual((await run.execute("show_form", "{\"form\":\"Andromeda Galaxy\"}")).result, { ok: false, status: "form-not-found" });
  assert.deepEqual((await run.execute("show_form", "{\"form\":\"<b>\"}")).result, { ok: false, status: "invalid-arguments" });
  assert.deepEqual((await run.execute("show_form", "{\"form\":\"tao.qian\",\"size\":2}")).result, { ok: false, status: "invalid-arguments" });
  assert.deepEqual((await run.execute("show_form", "not json")).result, { ok: false, status: "invalid-arguments" });
  assert.equal(submitted.length, 0);
});

test("resolver trace: a form is constructed by visual-forms, with no provider chain or fetch", async () => {
  const r = resolver();
  const target = await r.resolve({ type: "form", form: "astronomy.pleiades" }, new AbortController().signal);
  assert.equal(target.label, "Pleiades (star cluster)");
  const trace = r.lastTrace!;
  assert.equal(trace.status, "resolved");
  assert.equal(trace.provider, "visual-forms");
  assert.equal(trace.fetchMs, 0);
  assert.deepEqual(trace.chain.map(step => step.provider), ["visual-forms"]);
  assert.equal(trace.targetType, "points");
  assert.equal(trace.targetStyle, "celestial");
  assert.ok(trace.layout && trace.layout.points > 5);
});

test("show_form is one canonical tool shared by Realtime and GPT-Live, listing every registered form", () => {
  assert.equal(VISUAL_TOOL_NAMES.filter(name => name === "show_form").length, 1);
  const tool = visualTools.find(item => item.name === "show_form")!;
  assert.deepEqual(tool.parameters.required, ["form"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["form", "variant"]);
  assert.equal(tool.parameters.additionalProperties, false);
  for (const id of visualForms.ids()) assert.ok(String(tool.parameters.properties.form.description).includes(id), id);
  assert.match(String(tool.parameters.properties.variant.description), /later-heaven/);
  assert.match(tool.description, /no image search/);
  assert.equal(buildSessionConfig(sessionOptionsFromEnv({})).tools, visualTools);
  assert.equal(buildLiveSessionConfig(liveOptionsFromEnv({})).delegation.responses.tools, visualTools);
  // Both prompts carry the same rules; show_symbol keeps its small universal vocabulary.
  assert.match(VISUAL_TOOL_RULES, /show_form/);
  assert.ok(PRESENCE_INSTRUCTIONS.includes(VISUAL_TOOL_RULES) && LIVE_BACKEND_INSTRUCTIONS.includes(VISUAL_TOOL_RULES));
  assert.match(VISUAL_TOOL_RULES, /astronomy\.leo/);
  assert.match(LIVE_VOICE_INSTRUCTIONS, /constellations/, "the live voice knows to delegate these");
  assert.equal(SYMBOL_NAMES.length, 12);
  assert.deepEqual(visualTools.find(item => item.name === "show_symbol")!.parameters.properties.symbol.enum, [...SYMBOL_NAMES]);
});

test("debug panel: every visual-form test button names a registered form and passes validation", () => {
  const ids = new Set(FORM_SAMPLES.map(sample => sample.args.form));
  for (const id of ["tao.yin-yang", "tao.qian", "tao.kun", "tao.li", "tao.kan", "tao.bagua", "astronomy.orion", "astronomy.ursa-major",
    "astronomy.cassiopeia", "astronomy.pleiades", "astrology.aries", "astrology.leo", "astrology.scorpio", "astrology.pisces"]) assert.ok(ids.has(id), id);
  for (const sample of FORM_SAMPLES) {
    const action = toolCallToVisualAction("show_form", sample.args);
    assert.ok(action, sample.label);
    assert.deepEqual(validateVisualAction(action), action, sample.label);
  }
});

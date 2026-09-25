import test from "node:test";
import assert from "node:assert/strict";
import { VisualActionController } from "../src/visual-actions/controller";
import { HOSTS, safeFetch } from "../src/visual-resolver/net";
import { createTargetPoints } from "../src/visual-resolver/points";
import { scoreCandidate } from "../src/visual-resolver/providers/rank";
import { VisualResolver } from "../src/visual-resolver/resolve";
import {
  isTrustedAssetPath, LOCAL_ASSETS, localAssetProvider, matchLocalAsset, normalizeAssetQuery, type LocalAsset,
} from "../src/visual-resolver/sources/localAssets";
import { checkSvgText, normalizeLogoRaster, sizedSvg, svgRasterSize } from "../src/visual-resolver/transforms/svg";
import type { ImageProvider, Raster } from "../src/visual-resolver/types";
import { ToolExecutor } from "../src/voice/tools/executor";

const ORIGIN = "https://scf.test";
const LOGO_PATH = "/assets/brand/spirit-connect-logo.svg";
const LOGO_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 50" width="200" height="50">
<defs><linearGradient id="g"><stop offset="0" stop-color="#123"/></linearGradient></defs>
<rect id="r" x="10" y="10" width="180" height="30" fill="url(#g)"/><use xlink:href="#r"/></svg>`;
const signal = () => new AbortController().signal;

/** A same-origin static server: the logo exists (or not), everything else 404s. Records every URL. */
function server(files: Record<string, { body: string; type: string }> = { [LOGO_PATH]: { body: LOGO_SVG, type: "image/svg+xml" } }) {
  const urls: string[] = [];
  const request = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url.href);
    const file = url.origin === ORIGIN ? files[url.pathname] : undefined;
    return file ? new Response(file.body, { headers: { "content-type": file.type } }) : new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { request, urls };
}

/** Stand-in for the browser's canvas rasterizer: transparent, with an opaque mark in the middle. */
function fakeRasterize(calls: { width: number; height: number }[] = []) {
  return async (_text: string, size: { width: number; height: number }): Promise<Raster> => {
    calls.push(size);
    const { width, height } = size;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y++) {
      for (let x = Math.floor(width * 0.2); x < Math.floor(width * 0.8); x++) data.set([240, 240, 255, 255], (y * width + x) * 4);
    }
    return { width, height, data };
  };
}

function externalProvider(name: string) {
  const queries: string[] = [];
  const provider: ImageProvider = { name, search: async query => { queries.push(query); return []; } };
  return { provider, queries };
}

function resolver(options: { files?: Parameters<typeof server>[0]; assets?: readonly LocalAsset[] } = {}) {
  const { request, urls } = server(options.files);
  const external = ["wikipedia", "commons", "openverse", "web"].map(externalProvider);
  const sizes: { width: number; height: number }[] = [];
  const r = new VisualResolver({
    localAssets: localAssetProvider({ assets: options.assets, origin: () => ORIGIN, rasterizeSvg: fakeRasterize(sizes), decodeImage: async () => { throw new Error("unused"); }, request }),
    imageProviders: external.map(e => e.provider), terrainProviders: [], request,
    decodeImage: async () => { throw new Error("unused"); },
    glyphs: { text: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }), symbol: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }), emoji: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }) },
  });
  const externalQueries = () => external.flatMap(e => e.queries);
  return { r, urls, externalQueries, sizes };
}

test("manifest: the Spirit Connect logo is declared at its documented path", () => {
  const logo = LOCAL_ASSETS.find(asset => asset.id === "spirit-connect-logo");
  assert.ok(logo);
  assert.equal(logo.path, LOGO_PATH);
  assert.equal(logo.brand, "Spirit Connect");
  assert.equal(logo.type, "logo");
  for (const alias of ["spirit connect", "spiritconnect", "spirit connect logo", "our company logo", "my company logo", "company logo"]) {
    assert.ok(logo.aliases.includes(alias), alias);
  }
});

test("matching: exact aliases, case-insensitive, company-logo aliases and brand + logo words", () => {
  const id = (query: string) => matchLocalAsset(query)?.asset.id ?? null;
  const rule = (query: string) => matchLocalAsset(query)?.rule ?? null;
  assert.equal(normalizeAssetQuery("  Spirit-Connect's   LOGO! "), "spirit connect logo");
  for (const query of ["Spirit Connect logo", "SPIRIT CONNECT", "spirit connect", "SpiritConnect", "Spirit Connect Logo."]) {
    assert.equal(id(query), "spirit-connect-logo", query);
    assert.equal(rule(query), "alias", query);
  }
  for (const query of ["our company logo", "Our Company Logo", "my company logo", "My company's logo", "company logo", "the company logo"]) {
    assert.equal(id(query), "spirit-connect-logo", query);
  }
  for (const query of ["the Spirit Connect brand mark", "official Spirit Connect logo", "SpiritConnect icon", "Spirit Connect company logo"]) {
    assert.equal(id(query), "spirit-connect-logo", query);
    assert.equal(rule(query), "brand", query);
  }
});

test("matching: generic or unrelated queries never trigger the logo", () => {
  for (const query of ["company", "logo", "a company", "Spirit", "Connect", "Spirit Connect headquarters", "Spirit Airlines logo",
    "Tesla logo", "Apple company logo", "connect four", "spirits", "company logos of the world", "", "   "]) {
    assert.equal(matchLocalAsset(query), null, JSON.stringify(query));
  }
});

test("priority: a matching show_image query is answered locally; no external provider is consulted", async () => {
  const h = resolver();
  const target = await h.r.resolve({ type: "image", query: "Spirit Connect logo", intent: "product" }, signal());
  assert.deepEqual(h.externalQueries(), [], "Wikipedia, Commons, Openverse and the web search are never asked");
  assert.deepEqual(h.urls, [`${ORIGIN}${LOGO_PATH}`], "only the same-origin asset is read");
  assert.equal(target.label, "Spirit Connect");
  assert.equal(target.visual.kind, "raster2d");
  assert.equal(target.visual.kind === "raster2d" && target.visual.style, "logo");
  const trace = h.r.lastTrace!;
  assert.equal(trace.status, "resolved");
  assert.equal(trace.provider, "local-assets");
  assert.equal(trace.source, LOGO_PATH);
  assert.equal(`${trace.targetType}/${trace.targetStyle}`, "raster2d/logo");
  assert.equal(trace.chain.length, 1);
  assert.match(trace.chain[0].outcome, /^selected \(alias match: spirit-connect-logo\)$/);
  assert.deepEqual(h.sizes, [{ width: 400, height: 100 }], "rasterized at the SVG's own aspect ratio, at full target size");
});

test("generic queries keep the normal external chain", async () => {
  const h = resolver();
  await assert.rejects(h.r.resolve({ type: "image", query: "Tesla Model Y", intent: "vehicle" }, signal()), /image-not-found/);
  assert.ok(h.externalQueries().length >= 3, "external providers are consulted");
  assert.ok(!h.urls.some(url => url.includes("/assets/")), "local assets are not read");
  assert.ok(!h.r.lastTrace!.chain.some(step => step.provider === "local-assets"));
});

test("fallback rule: a matched asset that is missing or unusable fails predictably, with no web substitute", async () => {
  const missing = resolver({ files: {} });
  await assert.rejects(missing.r.resolve({ type: "image", query: "our company logo" }, signal()), /^ResolveError: image-unavailable$/);
  assert.deepEqual(missing.externalQueries(), [], "no random web result replaces a first-party logo");
  const trace = missing.r.lastTrace!;
  assert.equal(trace.status, "failed");
  assert.equal(trace.provider, "local-assets");
  assert.equal(trace.source, LOGO_PATH);
  assert.match(trace.chain[0].outcome, /^unavailable \(http-404\); no external fallback$/);

  const wrongType = resolver({ files: { [LOGO_PATH]: { body: "<html></html>", type: "text/html" } } });
  await assert.rejects(wrongType.r.resolve({ type: "image", query: "Spirit Connect logo" }, signal()), /image-unavailable/);
  assert.match(wrongType.r.lastTrace!.chain[0].outcome, /unavailable \(type\)/);

  const unsafe = resolver({ files: { [LOGO_PATH]: { body: `<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>`, type: "image/svg+xml" } } });
  await assert.rejects(unsafe.r.resolve({ type: "image", query: "Spirit Connect logo" }, signal()), /image-unavailable/);
  assert.match(unsafe.r.lastTrace!.chain[0].outcome, /svg-unsafe-script/);
  assert.deepEqual(unsafe.externalQueries(), []);
});

test("no arbitrary remote SVG: only same-origin /assets/ paths; remote SVG candidates stay rejected", async () => {
  assert.ok(isTrustedAssetPath(LOGO_PATH));
  assert.ok(isTrustedAssetPath("/assets/products/mark-2.png"));
  for (const path of ["https://evil.example/logo.svg", "//evil.example/assets/logo.svg", "/assets/../secret.svg", "/assets/brand/logo.svg?x=1",
    "/public/logo.svg", "assets/brand/logo.svg", "/assets/brand/logo.svg.js", "/assets/brand/%2e%2e/logo.svg", "data:image/svg+xml,<svg/>"]) {
    assert.equal(isTrustedAssetPath(path), false, path);
  }
  const remote: LocalAsset = { id: "evil", brand: "Evil", type: "logo", path: "https://evil.example/logo.svg", aliases: ["evil logo"] };
  const h = resolver({ assets: [remote] });
  await assert.rejects(h.r.resolve({ type: "image", query: "evil logo" }, signal()), /image-unavailable/);
  assert.deepEqual(h.urls, [], "nothing was fetched");
  assert.match(h.r.lastTrace!.chain[0].outcome, /asset-path-rejected/);
  // The loader's network guard itself refuses anything but the page's own origin.
  await assert.rejects(safeFetch("https://evil.example/logo.svg", { hosts: [], mimes: ["image/svg+xml"], maxBytes: 1000, signal: signal(), base: ORIGIN, request: server().request }), /url-rejected/);
  // External image providers still never accept SVG.
  assert.equal(scoreCandidate({ provider: "commons", url: `https://${HOSTS.wikimediaImages[0]}/x.svg`, title: "Spirit Connect logo", relevance: 1, width: 800, height: 400, mime: "image/svg+xml" }, "Spirit Connect logo", "general"), null);
});

test("SVG safety check: self-contained, script-free documents only", () => {
  checkSvgText(LOGO_SVG);
  checkSvgText(`<svg viewBox="0 0 4 4"><image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/></svg>`);
  const refused: [string, RegExp][] = [
    [`<svg><script>alert(1)</script></svg>`, /svg-unsafe-script/],
    [`<svg onload="alert(1)"></svg>`, /svg-unsafe-event-handler/],
    [`<svg><foreignObject><div/></foreignObject></svg>`, /svg-unsafe-foreign-object/],
    [`<svg><a href="javascript:alert(1)"><rect/></a></svg>`, /svg-unsafe-/],
    [`<svg><image href="https://evil.example/x.png"/></svg>`, /svg-unsafe-external-reference/],
    [`<svg><use xlink:href="https://evil.example/s.svg#a"/></svg>`, /svg-unsafe-external-reference/],
    [`<svg><rect style="fill:url(https://evil.example/p)"/></svg>`, /svg-unsafe-external-reference/],
    [`<svg><style>@import url(x.css);</style></svg>`, /svg-unsafe-/],
    [`<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`, /svg-unsafe-entity/],
    [`<html><body>not an svg</body></html>`, /svg-invalid/],
  ];
  for (const [text, error] of refused) assert.throws(() => checkSvgText(text), error, text);
});

test("SVG sizing: aspect ratio from viewBox or size, scaled to the target, explicit size injected", () => {
  assert.deepEqual(svgRasterSize(`<svg viewBox="0 0 200 50">`), { width: 400, height: 100 });
  assert.deepEqual(svgRasterSize(`<svg viewBox="0,0,50,100">`), { width: 200, height: 400 });
  assert.deepEqual(svgRasterSize(`<svg width="300px" height="100">`), { width: 400, height: 133 });
  assert.deepEqual(svgRasterSize(`<svg>`), { width: 400, height: 400 }, "no size information: square");
  assert.deepEqual(svgRasterSize(`<svg viewBox="0 0 10000 1">`), { width: 400, height: 33 }, "extreme aspects are clamped");
  assert.equal(sizedSvg(`<svg width="10" viewBox="0 0 2 1" height='5'><rect/></svg>`, { width: 400, height: 200 }),
    `<svg width="400" height="200" viewBox="0 0 2 1"><rect/></svg>`);
});

function raster(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const inMark = (x: number, y: number) => x >= 30 && x < 70 && y >= 20 && y < 40;

test("logo normalization: transparency preserved, a plain white background keyed out, margins trimmed", () => {
  const transparent = normalizeLogoRaster(raster(100, 60, (x, y) => inMark(x, y) ? [20, 60, 200, 255] : [0, 0, 0, 0]));
  assert.equal(transparent.style, "logo");
  const t = transparent.raster;
  assert.ok(t.width < 100 && t.height < 60, "trimmed to the mark");
  assert.ok(Math.abs(t.width / t.height - 2) < 0.2, "aspect ratio preserved");
  assert.equal(t.data[3], 0, "the transparent margin stays transparent");
  assert.equal(t.data[(Math.floor(t.height / 2) * t.width + Math.floor(t.width / 2)) * 4 + 3], 255, "the mark stays opaque");

  const onWhite = normalizeLogoRaster(raster(100, 60, (x, y) => inMark(x, y) ? [20, 60, 200, 255] : [255, 255, 255, 255]));
  const w = onWhite.raster;
  assert.equal(w.data[3], 0, "no white background rectangle");
  assert.equal(w.data[(Math.floor(w.height / 2) * w.width + Math.floor(w.width / 2)) * 4 + 3], 255);

  const busy = normalizeLogoRaster(raster(40, 40, (x, y) => [(x * 37) % 256, (y * 91) % 256, ((x + y) * 53) % 256, 255]));
  assert.ok(busy.raster.data.every((value, i) => i % 4 !== 3 || value === 255), "full-bleed artwork is not guessed at");
  assert.throws(() => normalizeLogoRaster(raster(20, 20, () => [0, 0, 0, 0])), /asset-empty/);
});

test("logo sampling: particles only on the mark, even density, no vignette, even tones for a one-colour mark", () => {
  const target = normalizeLogoRaster(raster(100, 60, (x, y) => inMark(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const { positions, tones } = createTargetPoints(target, 4000);
  const { width, height, data } = target.raster;
  const aspect = width / height, h = Math.min(2.6, 3.4 / aspect), w = h * aspect;
  let outside = 0, corners = 0, centre = 0;
  for (let i = 0; i < 4000; i++) {
    const px = Math.min(width - 1, Math.max(0, Math.floor((positions[i * 3] / w + 0.5) * width)));
    const py = Math.min(height - 1, Math.max(0, Math.floor((0.5 - positions[i * 3 + 1] / h) * height)));
    if (data[(py * width + px) * 4 + 3] < 128) outside++;
    const nx = positions[i * 3] / (w / 2), ny = positions[i * 3 + 1] / (h / 2);
    if (Math.abs(nx) > 0.6 && Math.abs(ny) > 0.4) corners++;
    if (Math.abs(nx) < 0.4 && Math.abs(ny) < 0.4) centre++;
  }
  assert.ok(outside < 40, `particles off the mark: ${outside}`);
  assert.ok(corners > 0.1 * 4000 && centre > 0.1 * 4000, "the mark's corners are as dense as its centre (no vignette)");
  assert.ok(Array.from(tones).every(tone => tone >= 0.6 && tone <= 0.95), "one-colour mark: even light");
});

test("show_image integration: the shared ToolExecutor forms the particle logo from the local asset", async () => {
  const h = resolver();
  const visual = new VisualActionController(h.r.resolve);
  const executor = new ToolExecutor(visual);
  const execution = await executor.execute("show_image", JSON.stringify({ query: "Spirit Connect logo" }));
  assert.deepEqual(execution.action, { type: "image", query: "Spirit Connect logo" });
  assert.deepEqual(execution.result, { ok: true, status: "displayed" });
  for (let i = 0; i < 10; i++) visual.sample(1 / 60);
  assert.equal(visual.target?.label, "Spirit Connect");
  assert.equal(visual.target?.visual.kind === "raster2d" && visual.target.visual.style, "logo");
  assert.deepEqual(h.externalQueries(), []);

  const missing = resolver({ files: {} });
  const failing = new ToolExecutor(new VisualActionController(missing.r.resolve));
  assert.deepEqual((await failing.execute("show_image", JSON.stringify({ query: "our company logo" }))).result, { ok: false, status: "image-unavailable" },
    "the model hears that the logo is unavailable, not a substitute");
});

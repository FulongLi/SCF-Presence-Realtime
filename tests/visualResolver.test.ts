import test from "node:test";
import assert from "node:assert/strict";
import { checkedURL, fetchImage, fetchJSON, HOSTS, overlap, safeFetch, sniffImage } from "../src/visual-resolver/net";
import { rankCandidates, scoreCandidate } from "../src/visual-resolver/providers/rank";
import { PROVIDER_ORDER, resolveImage } from "../src/visual-resolver/providers/images";
import { commonsProvider, wikipediaProvider } from "../src/visual-resolver/sources/wikimedia";
import { openverseProvider } from "../src/visual-resolver/sources/openverse";
import { webSearchProvider } from "../src/visual-resolver/sources/webSearch";
import { cropToAspect, normalizeImage, resizeRaster, trimBackground } from "../src/visual-resolver/transforms/crop";
import { VisualResolver } from "../src/visual-resolver/resolve";
import { createTargetPoints } from "../src/visual-resolver/points";
import type { ImageCandidate, ImageProvider, Raster, ResolveTrace } from "../src/visual-resolver/types";

const signal = () => new AbortController().signal;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]);
const image = (bytes = JPEG, type = "image/jpeg", extra: Record<string, string> = {}) =>
  new Response(bytes, { headers: { "content-type": type, ...extra } });
const trace = (): ResolveTrace => ({ action: "image", status: "resolving", chain: [], fetchMs: 0 });

function paint(width: number, height: number, fn: (x: number, y: number) => [number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...fn(x, y), 255], (y * width + x) * 4);
  return { width, height, data };
}
/** A dark "car" on a white floor. */
const carPhoto = () => paint(120, 80, (x, y) => x >= 30 && x < 90 && y >= 30 && y < 60 ? [30, 40, 60] : [245, 245, 245]);
const decode = async () => carPhoto();

test("net: only HTTPS allowlisted hosts, no credentials, ports or oversized URLs", () => {
  for (const url of ["http://upload.wikimedia.org/a.jpg", "https://upload.wikimedia.org.evil.test/a.jpg", "https://evil.test/a.jpg",
    "https://user:pw@upload.wikimedia.org/a.jpg", "https://upload.wikimedia.org:444/a.jpg", "javascript:alert(1)", `https://upload.wikimedia.org/${"a".repeat(3000)}`]) {
    assert.throws(() => checkedURL(url, HOSTS.wikimediaImages), url);
  }
  assert.equal(checkedURL("https://en.wikipedia.org/w/api.php", [HOSTS.wikipedia]).hostname, "en.wikipedia.org");
  assert.equal(checkedURL("https://zh.wikipedia.org/w/api.php", [HOSTS.wikipedia]).hostname, "zh.wikipedia.org");
  assert.throws(() => checkedURL("https://en.wikipedia.org.evil.test/", [HOSTS.wikipedia]));
  // SCF's own routes are same-origin only.
  assert.equal(checkedURL("/api/visual/image", [], "http://localhost:3000").pathname, "/api/visual/image");
  assert.throws(() => checkedURL("https://evil.test/api", [], "http://localhost:3000"));
});

test("net: requests are anonymous, refuse redirects, and check type, content and size", async () => {
  const seen: RequestInit[] = [];
  const request = (async (_input: unknown, init?: RequestInit) => { seen.push(init!); return image(); }) as typeof fetch;
  const { blob } = await fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request });
  assert.equal(blob.type, "image/jpeg");
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].credentials, "omit");
  assert.equal(seen[0].referrerPolicy, "no-referrer");
  const html = (async () => new Response("<html><script>", { headers: { "content-type": "text/html" } })) as typeof fetch;
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: html }), /^ResolveError: type$/);
  // A lying content type is caught by the magic bytes.
  const lying = (async () => image(new TextEncoder().encode("<svg onload=alert(1)>".padEnd(100)), "image/jpeg")) as typeof fetch;
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: lying }), /type/);
  const svg = (async () => image(PNG, "image/svg+xml")) as typeof fetch;
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.svg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: svg }), /type/);
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  assert.equal(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null, "GIF is not accepted");
});

test("net: oversized images are refused by header and while streaming", async () => {
  const declared = (async () => image(JPEG, "image/jpeg", { "content-length": String(50 * 1024 * 1024) })) as typeof fetch;
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: declared }), /too-large/);
  const big = new Uint8Array(300_000); big.set(JPEG.subarray(0, 4));
  const streamed = (async () => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < 3; i++) controller.enqueue(big.subarray(i * 100_000, (i + 1) * 100_000)); controller.close(); },
  }), { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: streamed, maxBytes: 150_000 }), /too-large/);
});

test("net: a hung request times out; a caller's cancellation is not a timeout", async () => {
  const hang = ((_input: unknown, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  await assert.rejects(safeFetch("https://api.openverse.org/v1/images/", { hosts: [HOSTS.openverse], mimes: ["application/json"], maxBytes: 100, signal: signal(), request: hang, timeoutMs: 30 }), /timeout/);
  const abort = new AbortController();
  const pending = safeFetch("https://api.openverse.org/v1/images/", { hosts: [HOSTS.openverse], mimes: ["application/json"], maxBytes: 100, signal: abort.signal, request: hang, timeoutMs: 5000 });
  abort.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  const broken = (async () => new Response("{", { headers: { "content-type": "application/json" } })) as typeof fetch;
  await assert.rejects(fetchJSON("https://api.openverse.org/x", { hosts: [HOSTS.openverse], signal: signal(), request: broken }), /bad-json/);
  const missing = (async () => new Response("", { status: 404 })) as typeof fetch;
  await assert.rejects(fetchJSON("https://api.openverse.org/x", { hosts: [HOSTS.openverse], signal: signal(), request: missing }), /http-404/);
});

test("ranking: relevance, usable size and aspect, raster types, and off-topic results", () => {
  const base = { provider: "commons", url: "https://upload.wikimedia.org/x.jpg", relevance: 1, width: 960, height: 640, mime: "image/jpeg" };
  const c = (patch: Partial<ImageCandidate>): ImageCandidate => ({ ...base, title: "Tesla Model Y", ...patch });
  assert.equal(scoreCandidate(c({ mime: "image/svg+xml" }), "Tesla Model Y", "vehicle"), null);
  assert.equal(scoreCandidate(c({ mime: "image/gif" }), "Tesla Model Y", "vehicle"), null);
  assert.equal(scoreCandidate(c({ width: 100, height: 80 }), "Tesla Model Y", "vehicle"), null, "no tiny thumbnails");
  assert.equal(scoreCandidate(c({ width: 4000, height: 400 }), "Tesla Model Y", "vehicle"), null, "no panoramic strips");
  assert.equal(scoreCandidate(c({ relevance: 0.1 }), "Tesla Model Y", "vehicle"), null, "irrelevant");
  const ranked = rankCandidates([
    c({ title: "Nikola Tesla signature", relevance: 0.9, width: 600, height: 800 }),
    c({ title: "Nikola Tesla portrait", relevance: 0.9, width: 600, height: 800 }),
    c({ title: "Nikola Tesla wide", relevance: 0.9, width: 1600, height: 600 }),
  ], "Nikola Tesla", "portrait");
  assert.deepEqual(ranked.map(x => x.title), ["Nikola Tesla portrait", "Nikola Tesla wide", "Nikola Tesla signature"]);
  assert.ok(overlap("Tesla Model Y", "TESLA model-Y 2025") === 1);
  assert.ok(overlap("Škoda Kodiaq", "Skoda Kodiaq") === 1, "accents fold");
});

function jsonFetch(routes: [RegExp, unknown][], images = true) {
  const urls: string[] = [];
  const request = (async (input: string | URL) => {
    const url = String(input); urls.push(url);
    for (const [pattern, body] of routes) if (pattern.test(url)) return Response.json(body);
    if (images && /(upload|thumb)\.wikimedia\.org|openverse\.org\/v1\/images\/[0-9a-f-]+\/thumb/.test(url)) return image();
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { request, urls };
}

test("wikipedia provider: exact article lead image first, then a search it only trusts when titles match", async () => {
  const { request, urls } = jsonFetch([[/titles=Tesla/, { query: { pages: [{ title: "Tesla Model Y", thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e7/Y.jpg/960px-Y.jpg", width: 960, height: 514 } }] } }]]);
  const found = await wikipediaProvider(request).search("Tesla Model Y", "vehicle", signal());
  assert.equal(found.length, 1);
  assert.equal(found[0].relevance, 1);
  assert.equal(found[0].mime, "image/jpeg");
  assert.match(urls[0], /origin=\*/);
  assert.match(urls[0], /pilicense=free/);
  const search = jsonFetch([
    [/titles=/, { query: { pages: [{ title: "Futuristic concept car", missing: true }] } }],
    [/generator=search/, { query: { pages: [
      { title: "Retrofuturism", index: 1, thumbnail: { source: "https://upload.wikimedia.org/a.jpg", width: 700, height: 900 } },
      { title: "Concept car", index: 2, thumbnail: { source: "https://upload.wikimedia.org/b.jpg", width: 640, height: 448 } },
      { title: "Concept (disambiguation)", index: 3, pageprops: { disambiguation: "" }, thumbnail: { source: "https://upload.wikimedia.org/c.jpg", width: 640, height: 448 } },
    ] } }],
  ]);
  const results = await wikipediaProvider(search.request).search("futuristic concept car", "vehicle", signal());
  assert.deepEqual(results.map(r => r.title), ["Concept car"], "unrelated and disambiguation pages are skipped");
  const chinese = jsonFetch([[/zh\.wikipedia\.org/, { query: { pages: [] } }]]);
  await wikipediaProvider(chinese.request).search("尼古拉·特斯拉", "portrait", signal());
  assert.match(chinese.urls[0], /^https:\/\/zh\.wikipedia\.org/);
});

test("commons and openverse providers turn search results into candidates from allowlisted image hosts", async () => {
  const commons = jsonFetch([[/commons\.wikimedia\.org/, { query: { pages: [
    { title: "File:Wind turbine, Wales.jpg", index: 1, imageinfo: [{ url: "https://upload.wikimedia.org/w.jpg", thumburl: "https://thumb.wikimedia.org/w/960px-w.jpg", thumbwidth: 960, thumbheight: 640, mime: "image/jpeg", thumbmime: "image/jpeg", descriptionurl: "https://commons.wikimedia.org/wiki/File:W.jpg" }] },
    { title: "File:Turbine map.svg", index: 2, imageinfo: [{ url: "https://upload.wikimedia.org/m.svg", thumburl: "https://thumb.wikimedia.org/m/960px-m.svg.png", thumbwidth: 960, thumbheight: 800, mime: "image/svg+xml", thumbmime: "image/png" }] },
  ] } }]]);
  const found = await commonsProvider(commons.request).search("wind turbine", "object", signal());
  assert.equal(found[0].url, "https://thumb.wikimedia.org/w/960px-w.jpg");
  assert.equal(found[1].mime, "image/png", "SVG originals are used through their rasterized thumbnails");
  assert.match(commons.urls[0], /filetype%3Abitmap/);
  const id = "cfe5e0c0-439f-42dc-ae0e-f1ca68dfc06b";
  const openverse = jsonFetch([[/api\.openverse\.org\/v1\/images\/\?/, { results: [
    { id, title: "TESLA Model Y", width: 1024, height: 683, license: "by", provider: "flickr", tags: [{ name: "electric" }] },
    { id: "not-a-uuid", title: "Tesla Model Y" },
    { id: "0e2e8b9e-0000-4000-8000-000000000000", title: "Tesla Model Y", mature: true },
  ] }]]);
  const images = await openverseProvider(openverse.request).search("Tesla Model Y", "vehicle", signal());
  assert.equal(images.length, 1);
  assert.equal(images[0].url, `https://api.openverse.org/v1/images/${id}/thumb/`);
  assert.match(openverse.urls[0], /mature=false/);
});

function fakeProvider(name: string, result: ImageCandidate[] | Error, calls: string[]): ImageProvider {
  return {
    name,
    async search(query) {
      calls.push(`${name}:${query}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
const candidate = (provider: string, patch: Partial<ImageCandidate> = {}): ImageCandidate => ({
  provider, url: "https://upload.wikimedia.org/x.jpg", title: "x", relevance: 1, width: 900, height: 600, mime: "image/jpeg", ...patch,
});

test("provider selection follows the intent; portraits, vehicles, objects and references differ", async () => {
  assert.deepEqual(PROVIDER_ORDER.portrait.slice(0, 2), ["wikipedia", "web"]);
  assert.deepEqual(PROVIDER_ORDER.vehicle.slice(0, 2), ["wikipedia", "commons"]);
  assert.equal(PROVIDER_ORDER.reference[0], "openverse");
  assert.equal(PROVIDER_ORDER.map[0], "commons");
  for (const [intent, first] of [["portrait", "wikipedia"], ["vehicle", "wikipedia"], ["object", "wikipedia"], ["general", "openverse"]] as const) {
    const calls: string[] = [];
    const providers = ["wikipedia", "commons", "openverse", "web"].map(name => fakeProvider(name, [candidate(name)], calls));
    const { request } = jsonFetch([]);
    const result = await resolveImage("mountain bike", intent, { providers, decode, request }, signal(), trace());
    assert.equal(result.candidate.provider, first, intent);
    assert.equal(calls.length, 1, "the first provider with a usable image wins");
  }
});

test("provider fallback: empty, failing and undownloadable providers hand over to the next", async () => {
  const calls: string[] = [];
  const t = trace();
  const providers = [
    fakeProvider("wikipedia", [], calls),
    fakeProvider("web", new Error("not-configured"), calls),
    fakeProvider("openverse", [candidate("openverse", { url: "https://evil.test/x.jpg" })], calls),
    fakeProvider("commons", [candidate("commons", { title: "Taylor Swift 2023" })], calls),
  ];
  const { request } = jsonFetch([]);
  const result = await resolveImage("Taylor Swift", "celebrity", { providers, decode, request }, signal(), t);
  assert.equal(result.candidate.provider, "commons");
  assert.deepEqual(t.chain.map(step => `${step.provider}: ${step.outcome}`), [
    "wikipedia: no results", "web: not-configured", "openverse: download url-rejected", "commons: selected (1 usable)",
  ]);
  assert.equal(result.target.style, "portrait");
});

test("no-result handling: not-found when nothing matched, unavailable when sources failed", async () => {
  const { request } = jsonFetch([]);
  const none = ["wikipedia", "commons", "openverse"].map(name => fakeProvider(name, [], []));
  await assert.rejects(resolveImage("Qwxyzzy", "general", { providers: none, decode, request }, signal(), trace()), /image-not-found/);
  await assert.rejects(resolveImage("Qwxyzzy", "portrait", { providers: none, decode, request }, signal(), trace(), "portrait"), /portrait-not-found/);
  const down = ["wikipedia", "commons", "openverse"].map(name => fakeProvider(name, new Error("http-503"), []));
  await assert.rejects(resolveImage("Tesla Model Y", "vehicle", { providers: down, decode, request }, signal(), trace()), /image-unavailable/);
  const invalid = [fakeProvider("wikipedia", [candidate("wikipedia")], [])];
  const badDecode = async () => { throw new Error("image-invalid"); };
  await assert.rejects(resolveImage("Tesla Model Y", "vehicle", { providers: invalid, decode: badDecode, request }, signal(), trace()), /image-unavailable/);
});

test("the web provider only talks to SCF's own route and switches itself off without a key", async () => {
  let calls = 0;
  const off = (async (input: URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "http://localhost:3000/api/visual/image");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "iPhone", intent: "product" });
    return Response.json({ error: "not-configured" }, { status: 503 });
  }) as unknown as typeof fetch;
  const provider = webSearchProvider(() => "http://localhost:3000", off);
  await assert.rejects(provider.search("iPhone", "product", signal()), /not-configured/);
  await assert.rejects(provider.search("iPhone", "product", signal()), /not-configured/);
  assert.equal(calls, 1, "a missing key is remembered for the page");
  const on = webSearchProvider(() => "http://localhost:3000", (async () => image()) as typeof fetch);
  const [found] = await on.search("iPhone", "product", signal());
  assert.equal((await found.load!(signal())).type, "image/jpeg");
});

test("crop: aspect crops keep the centre horizontally and the anchor vertically", () => {
  const tall = paint(40, 120, (_, y) => [y, y, y]);
  const top = cropToAspect(tall, 0.8, 1, 0);
  assert.deepEqual([top.width, top.height], [40, 50]);
  assert.equal(top.data[0], 0, "anchored at the top");
  const centre = cropToAspect(tall, 0.8, 1, 0.5);
  assert.equal(centre.data[0], 35);
  const wide = paint(300, 100, x => [x % 256, 0, 0]);
  const cropped = cropToAspect(wide, 0.5, 2);
  assert.deepEqual([cropped.width, cropped.height], [200, 100]);
  assert.equal(cropped.data[0], 50);
  assert.equal(cropToAspect(paint(100, 100, () => [0, 0, 0]), 0.5, 2).width, 100, "in-range images are untouched");
});

test("crop: a plain background around an object is trimmed; busy photos are not", () => {
  const trimmed = trimBackground(carPhoto());
  assert.ok(trimmed.width < 80 && trimmed.width >= 60, `width ${trimmed.width}`);
  assert.ok(trimmed.height < 45 && trimmed.height >= 30, `height ${trimmed.height}`);
  const busy = paint(64, 64, (x, y) => [(x * 37) % 255, (y * 91) % 255, (x * y) % 255]);
  assert.equal(trimBackground(busy), busy);
  const small = resizeRaster(paint(1200, 600, () => [10, 20, 30]), 300);
  assert.deepEqual([small.width, small.height], [300, 150]);
  assert.deepEqual(Array.from(small.data.subarray(0, 4)), [10, 20, 30, 255]);
});

test("normalization by intent: portraits get a head-and-shoulders crop, objects keep the object", () => {
  const person = normalizeImage(paint(600, 1200, () => [120, 110, 100]), "portrait");
  assert.equal(person.style, "portrait");
  const aspect = person.raster.width / person.raster.height;
  assert.ok(aspect >= 0.72 - 0.01 && aspect <= 1.05, `portrait aspect ${aspect}`);
  assert.ok(Math.max(person.raster.width, person.raster.height) <= 300);
  const car = normalizeImage(carPhoto(), "vehicle");
  assert.equal(car.style, "object");
  assert.ok(car.raster.width / car.raster.height > 1.5, "a wide vehicle stays wide");
  const points = createTargetPoints(car, 4000);
  // Object sampling puts most particles on the car, not on the white floor.
  let dark = 0;
  for (let i = 0; i < 4000; i++) if (points.tones[i] < 0.4) dark++;
  assert.ok(dark > 2400, `dark particles ${dark}`);
});

function resolver(providers: ImageProvider[], request?: typeof fetch, deadlineMs = 2000) {
  const glyph = paint(20, 10, () => [255, 255, 255]);
  return new VisualResolver({
    imageProviders: providers, terrainProviders: [], decodeImage: decode, request, deadlineMs,
    glyphs: { text: () => glyph, symbol: () => glyph, emoji: () => glyph }, now: () => new Date(2026, 8, 25, 9, 30),
  });
}

test("resolver: image and portrait actions become Raster2D targets, with a full trace", async () => {
  const { request } = jsonFetch([]);
  const r = resolver([fakeProvider("wikipedia", [candidate("wikipedia", { title: "Tesla Model Y", pageUrl: "https://en.wikipedia.org/wiki/Tesla_Model_Y" })], [])], request);
  const target = await r.resolve({ type: "image", query: "Tesla Model Y", intent: "vehicle" }, signal());
  assert.equal(target.visual.kind, "raster2d");
  assert.equal(target.label, "Tesla Model Y");
  assert.equal(target.hold, 12);
  const t = r.lastTrace!;
  assert.equal(t.status, "resolved");
  assert.equal(t.provider, "wikipedia");
  assert.equal(t.targetType, "raster2d");
  assert.ok(t.raster!.width > 0);
  assert.ok(t.resolveMs! >= 0);
  const portrait = await r.resolve({ type: "portrait", person: "Nikola Tesla" }, signal());
  assert.equal(portrait.visual.kind === "raster2d" && portrait.visual.style, "portrait");
  const clock = await r.resolve({ type: "clock" }, signal());
  assert.equal(clock.label, "09:30");
  assert.equal(r.lastTrace!.provider, "canvas");
});

test("resolver: failures carry model-safe codes, and the deadline bounds a slow chain", async () => {
  const empty = resolver([fakeProvider("wikipedia", [], []), fakeProvider("openverse", [], [])]);
  await assert.rejects(empty.resolve({ type: "portrait", person: "Nobody In Particular" }, signal()), /^ResolveError: portrait-not-found$/);
  assert.equal(empty.lastTrace!.status, "failed");
  await assert.rejects(empty.resolve({ type: "image", query: "Qwxyzzy" }, signal()), /^ResolveError: image-not-found$/);
  const slow: ImageProvider = { name: "openverse", search: (_q, _i, s) => new Promise((_, reject) => s.addEventListener("abort", () => reject(s.reason))) };
  const stuck = resolver([slow], undefined, 40);
  await assert.rejects(stuck.resolve({ type: "image", query: "concept car" }, signal()), /^ResolveError: image-unavailable$/);
  const abort = new AbortController();
  const pending = resolver([slow]).resolve({ type: "image", query: "concept car" }, abort.signal);
  abort.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError", "cancellation is not reported as a failure");
  const noTerrain = resolver([]);
  await assert.rejects(noTerrain.resolve({ type: "terrain", region: "Wales" }, signal()), /^ResolveError: terrain-unavailable$/);
});

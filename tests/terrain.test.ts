import test from "node:test";
import assert from "node:assert/strict";
import {
  brightnessSource, buildHeightField, decodeTerrarium, downsampleGrid, heightRange, rasterizePolygon,
} from "../src/visual-resolver/transforms/heightfield";
import { elevationTilesProvider, geocode, mercatorX, mercatorY, normalizeBox, planTiles, terrainLimits } from "../src/visual-resolver/sources/terrain";
import { resolveTerrain } from "../src/visual-resolver/providers/terrain";
import { createTargetPoints, terrainLayout } from "../src/visual-resolver/points";
import { VisualResolver } from "../src/visual-resolver/resolve";
import type { HeightFieldTarget, Raster, ResolveTrace, TerrainProvider, TerrainSource, VisualTarget } from "../src/visual-resolver/types";

const signal = () => new AbortController().signal;
const trace = (): ResolveTrace => ({ action: "terrain", status: "resolving", chain: [], fetchMs: 0 });

/** Terrarium-encodes metres into an RGBA pixel. */
function encode(metres: number): [number, number, number, number] {
  const v = metres + 32768;
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v - Math.floor(v)) * 256) % 256, 255];
}

test("terrarium decoding recovers metres; transparent pixels are no-data", () => {
  const data = new Uint8ClampedArray(16);
  data.set(encode(0), 0); data.set(encode(1085.5), 4); data.set(encode(-42), 8); data.set([0, 0, 0, 0], 12);
  const metres = decodeTerrarium({ width: 4, height: 1, data });
  assert.deepEqual(Array.from(metres.subarray(0, 3)), [0, 1085.5, -42]);
  assert.ok(Number.isNaN(metres[3]));
});

test("polygon rasterization fills the inside of rings (even-odd), including holes and multiple parts", () => {
  const square: [number, number][] = [[2, 2], [8, 2], [8, 8], [2, 8]];
  const mask = rasterizePolygon([square], 10, 10);
  assert.equal(mask.reduce((a, b) => a + b, 0), 36);
  assert.equal(mask[5 * 10 + 5], 1);
  assert.equal(mask[0], 0);
  const hole: [number, number][] = [[4, 4], [6, 4], [6, 6], [4, 6]];
  assert.equal(rasterizePolygon([square, hole], 10, 10).reduce((a, b) => a + b, 0), 32);
  const island: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(rasterizePolygon([square, island], 10, 10)[0], 1);
});

test("region boxes: points grow to a readable area, continents are capped, zoom and tiles stay bounded", () => {
  const point = normalizeBox({ west: 86.925, east: 86.925, south: 27.988, north: 27.988 });
  assert.ok(Math.abs(point.east - point.west - terrainLimits.pointSpan) < 1e-9);
  const huge = normalizeBox({ west: -170, east: 170, south: -80, north: 89 });
  assert.ok(huge.east - huge.west <= terrainLimits.maxSpan + 1e-9);
  assert.ok(huge.north <= 84);
  const antimeridian = normalizeBox({ west: 170, east: -170, south: -20, north: -10 });
  assert.ok(antimeridian.east > antimeridian.west && antimeridian.east - antimeridian.west <= 21);
  const wales = planTiles(normalizeBox({ west: -5.81, east: -2.65, south: 51.23, north: 53.64 }));
  const uk = planTiles(normalizeBox({ west: -14.02, east: 2.09, south: 49.67, north: 61.06 }));
  for (const plan of [wales, uk]) {
    assert.ok(plan.x1 - plan.x0 <= terrainLimits.maxPixels && plan.y1 - plan.y0 <= terrainLimits.maxPixels);
    assert.ok((plan.tx1 - plan.tx0 + 1) * (plan.ty1 - plan.ty0 + 1) <= terrainLimits.maxTiles);
  }
  assert.ok(wales.z > uk.z, "a smaller region gets more detail");
  assert.ok(Math.abs(mercatorY(0, 0) - 128) < 1e-9 && Math.abs(mercatorX(0, 0) - 128) < 1e-9);
});

test("geocoding: Nominatim with outline first, Photon as fallback, and 'not found' when nobody knows the place", async () => {
  const urls: string[] = [];
  const nominatim = (async (input: URL, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(init?.referrerPolicy, "strict-origin", "Nominatim sees the app's origin, per its usage policy");
    return Response.json([{ name: "Cymru / Wales", boundingbox: ["51.2", "53.6", "-5.8", "-2.6"],
      geojson: { type: "MultiPolygon", coordinates: [[[[-5, 52], [-3, 52], [-3, 53], [-5, 53], [-5, 52]]]] } }]);
  }) as unknown as typeof fetch;
  const wales = await geocode("Wales", signal(), nominatim);
  assert.equal(wales.label, "Cymru / Wales");
  assert.deepEqual(wales.box, { south: 51.2, north: 53.6, west: -5.8, east: -2.6 });
  assert.equal(wales.rings?.length, 1);
  assert.match(urls[0], /polygon_geojson=1/);
  const photon = (async (input: URL) => String(input).includes("nominatim")
    ? new Response("", { status: 503 })
    : Response.json({ features: [{ properties: { name: "Wales", extent: [-5.8, 53.6, -2.6, 51.2] } }] })) as unknown as typeof fetch;
  const fallback = await geocode("Wales", signal(), photon);
  assert.equal(fallback.provider, "photon");
  assert.deepEqual(fallback.box, { west: -5.8, north: 53.6, east: -2.6, south: 51.2 });
  const nobody = (async (input: URL) => String(input).includes("nominatim") ? Response.json([]) : Response.json({ features: [] })) as unknown as typeof fetch;
  await assert.rejects(geocode("Narnia", signal(), nobody), /region-not-found/);
  const offline = (async () => { throw new TypeError("offline"); }) as typeof fetch;
  await assert.rejects(geocode("Wales", signal(), offline), /geocoder-unavailable/);
});

/** Elevation of the synthetic world: a mountain at (0.5°E, 50.7°N), plains west of 1.6°E, sea east of it. */
const world = (lon: number, lat: number) =>
  lon < 1.6 ? 40 + 1500 * Math.exp(-((lon - 0.5) ** 2 + (lat - 50.7) ** 2) / 0.05) : -30;
const unproject = (px: number, py: number, z: number) => {
  const size = 256 * 2 ** z;
  return [px / size * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * py / size))) * 180 / Math.PI];
};

function tileWorld() {
  const tiles: string[] = [];
  const request = (async (input: URL) => {
    const match = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(input));
    if (!match) return new Response("", { status: 404 });
    tiles.push(match.slice(1).join("/"));
    const bytes = new Uint8Array(64); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set(match.slice(1).map(Number).flatMap(v => [v >> 8, v & 255]), 8);
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
  const decode = async (blob: Blob): Promise<Raster> => {
    const b = new Uint8Array(await blob.arrayBuffer());
    const [z, x, y] = [0, 1, 2].map(i => (b[8 + i * 2] << 8) | b[9 + i * 2]);
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      const [lon, lat] = unproject(x * 256 + px + 0.5, y * 256 + py + 0.5, z);
      data.set(encode(world(lon, lat)), (py * 256 + px) * 4);
    }
    return { width: 256, height: 256, data };
  };
  return { request, decode, tiles };
}

test("elevation tiles: region → bounded tile set → masked elevation grid in metres", async () => {
  const { request, decode, tiles } = tileWorld();
  const locate = async () => ({ label: "Testland", provider: "test", box: { west: 0, east: 2, south: 50, north: 51.5 },
    rings: [[[0, 50], [1.2, 50], [1.2, 51.5], [0, 51.5], [0, 50]] as [number, number][]] });
  const source = await elevationTilesProvider(decode, request, locate).resolve("Testland", "terrain", signal());
  assert.ok(tiles.length > 0 && tiles.length <= terrainLimits.maxTiles, `${tiles.length} tiles`);
  assert.equal(source.kind, "elevation");
  assert.ok(Math.max(source.width, source.height) <= 160);
  assert.ok(source.mask, "the outline became a mask");
  let inside = 0, max = -Infinity;
  for (let i = 0; i < source.values.length; i++) if (source.mask![i]) { inside++; max = Math.max(max, source.values[i]); }
  assert.ok(inside > 100 && inside < source.values.length * 0.75, `inside ${inside}`);
  assert.ok(max > 1200, `peak ${max} m`);
  assert.ok(source.aspect > 0.8 && source.aspect < 1.2, `aspect ${source.aspect}`);
});

test("height field: land only, cropped to the region, percentile-normalized, relief from real range", () => {
  const w = 40, h = 30;
  const values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    values[y * w + x] = x >= 30 ? -50 : 20 + 900 * Math.exp(-((x - 12) ** 2 + (y - 15) ** 2) / 30);
  }
  values[3 * w + 3] = 9000; // one absurd spike must not flatten everything else
  const source: TerrainSource = { provider: "test", kind: "elevation", width: w, height: h, values, aspect: 4 / 3, label: "Test" };
  const field = buildHeightField(source, "terrain");
  assert.ok(field.width <= 32, "the sea east of x=30 is cropped away");
  const { min, max } = heightRange(field);
  assert.equal(min, 0);
  assert.equal(max, 1);
  const peak = field.values[15 * field.width + 12], plain = field.values[28 * field.width + 2];
  assert.ok(peak > 0.7, `peak ${peak}`);
  assert.ok(plain < 0.1, `plain ${plain}`);
  assert.ok(field.relief > 0.5 && field.relief <= 1);
  assert.deepEqual(field.elevation, { min: 20, max: 9000 });
  assert.ok(Math.abs(field.aspect - (4 / 3) * (field.width / w) / (field.height / h)) < 1e-6);
  // A flat country stays flat instead of amplifying noise.
  const flat = buildHeightField({ ...source, values: new Float32Array(w * h).map((_, i) => 2 + (i % 7)) });
  assert.ok(heightRange(flat).max < 0.05);
  // Mostly-water regions show the sea floor instead of failing.
  const ocean = buildHeightField({ ...source, values: new Float32Array(w * h).map((_, i) => -4000 + (i % w) * 50) });
  assert.ok(ocean.width === w && heightRange(ocean).max === 1);
});

test("height field rejects empty and malformed sources", () => {
  const base = { provider: "t", kind: "elevation" as const, width: 10, height: 10, aspect: 1, label: "x" };
  assert.throws(() => buildHeightField({ ...base, values: new Float32Array(100).fill(NaN) }), /heightfield-empty/);
  assert.throws(() => buildHeightField({ ...base, values: new Float32Array(99) }), /heightfield-invalid/);
  assert.throws(() => buildHeightField({ ...base, values: new Float32Array(100).fill(5), mask: new Uint8Array(100) }), /heightfield-empty/);
  const grid = downsampleGrid(new Float32Array(400 * 200).fill(3), 400, 200, 160);
  assert.deepEqual([grid.width, grid.height, grid.values[0]], [160, 80, 3]);
  const bright = brightnessSource({ width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]) }, "x");
  assert.equal(bright.values[0], 1);
  assert.ok(Number.isNaN(bright.values[1]));
});

function peakField(style: HeightFieldTarget["style"] = "terrain"): HeightFieldTarget {
  const w = 48, h = 32, values = new Float32Array(w * h), mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    values[y * w + x] = Math.exp(-((x - 24) ** 2 + (y - 16) ** 2) / 40);
    mask[y * w + x] = x < 44 ? 1 : 0;
  }
  return { kind: "heightfield", style, field: { width: w, height: h, values, mask, aspect: 1.5, relief: 1 } };
}

test("height-field particles have visible, readable Z relief on a tilted ground plane", () => {
  const target = peakField();
  const count = 6000;
  const { positions, tones } = createTargetPoints(target, count);
  const cos = Math.cos(terrainLayout.tilt), sin = Math.sin(terrainLayout.tilt), lift = terrainLayout.height * target.field.relief;
  // Undo the tilt to recover each particle's height above the ground plane.
  let centre = 0, centreN = 0, edge = 0, edgeN = 0, lo = Infinity, hi = -Infinity, maxX = -Infinity;
  for (let i = 0; i < count; i++) {
    const [x, y, z] = positions.subarray(i * 3, i * 3 + 3);
    const height = (y + lift * sin * 0.3) * sin + z * cos;
    const ground = (y + lift * sin * 0.3) * cos - z * sin;
    lo = Math.min(lo, height); hi = Math.max(hi, height); maxX = Math.max(maxX, x);
    if (Math.hypot(x, ground) < 0.3) { centre += height; centreN++; }
    if (Math.abs(x) > 1.3) { edge += height; edgeN++; }
    assert.ok(Math.abs(x) <= 1.9 && Math.abs(y) <= 1.8 && Math.abs(z) <= 2.2, "stays inside the view");
    assert.ok(tones[i] >= 0 && tones[i] <= 1);
  }
  assert.ok(hi - lo > 0.5 * lift, `relief ${hi - lo}`);
  assert.ok(centre / centreN > edge / edgeN + 0.4 * lift, "the mountain rises above the plain");
  assert.ok(maxX < (44 / 48 - 0.5) * terrainLayout.width + 0.05, "masked cells stay empty");
  // Quality tiers are prefixes of one stable sequence.
  assert.deepEqual(createTargetPoints(target, 1000).positions, positions.subarray(0, 3000));
  for (const style of ["topography", "relief", "heightmap"] as const) createTargetPoints(peakField(style), 200);
});

test("invalid targets are rejected before they reach the render loop", () => {
  const good = peakField();
  const bad: VisualTarget[] = [
    { ...good, field: { ...good.field, values: new Float32Array(10) } },
    { ...good, field: { ...good.field, values: good.field.values.map((v, i) => i === 5 ? NaN : v) } },
    { ...good, field: { ...good.field, values: good.field.values.map((v, i) => i === 5 ? 3 : v) } },
    { ...good, field: { ...good.field, aspect: 0 } },
    { ...good, field: { ...good.field, mask: new Uint8Array(good.field.values.length) } },
    { kind: "future-3d" } as unknown as VisualTarget,
    { kind: "raster2d", style: "object", raster: { width: 1000, height: 1000, data: new Uint8ClampedArray(4_000_000) } },
  ];
  for (const target of bad) assert.throws(() => createTargetPoints(target, 10), JSON.stringify(target).slice(0, 60));
});

test("terrain resolution: real elevation first, fallback on outage, fast failure for unknown regions", async () => {
  const { request, decode } = tileWorld();
  const locate = async () => ({ label: "Testland", provider: "test", box: { west: 0, east: 2, south: 50, north: 51.5 } });
  const tiles = elevationTilesProvider(decode, request, locate);
  const t = trace();
  const { target, source } = await resolveTerrain("Testland", "topography", [tiles], signal(), t);
  assert.equal(target.kind, "heightfield");
  assert.equal(target.style, "topography");
  assert.equal(source.kind, "elevation");
  assert.deepEqual(t.chain.map(step => step.outcome), ["selected"]);
  assert.ok(target.field.elevation!.max > 1200);

  const down = elevationTilesProvider(decode, (async () => new Response("", { status: 500 })) as typeof fetch, locate);
  const brightness: TerrainProvider = { name: "relief-image", resolve: async () => brightnessSource({ width: 20, height: 20,
    data: new Uint8ClampedArray(1600).map((_, i) => i % 4 === 3 ? 255 : (i >> 2) % 20 * 12) }, "Testland", "relief-image") };
  const fallback = trace();
  const result = await resolveTerrain("Testland", "terrain", [down, brightness], signal(), fallback);
  assert.equal(result.source.kind, "brightness");
  assert.deepEqual(fallback.chain.map(step => `${step.provider}: ${step.outcome}`), ["aws-terrain-tiles: http-500", "relief-image: selected"]);

  const unknown = elevationTilesProvider(decode, request, async () => { throw new (await import("../src/visual-resolver/types")).ResolveError("region-not-found"); });
  let consulted = false;
  const never: TerrainProvider = { name: "relief-image", resolve: async () => { consulted = true; throw new Error("x"); } };
  await assert.rejects(resolveTerrain("Narnia", "terrain", [unknown, never], signal(), trace()), /region-not-found/);
  assert.equal(consulted, false);
  await assert.rejects(resolveTerrain("Testland", "terrain", [down], signal(), trace()), /terrain-unavailable/);
});

test("resolver: a terrain action becomes a HeightField target with elevation diagnostics", async () => {
  const { request, decode } = tileWorld();
  const locate = async () => ({ label: "Testland", provider: "test", box: { west: 0, east: 2, south: 50, north: 51.5 } });
  const resolver = new VisualResolver({
    imageProviders: [], terrainProviders: [elevationTilesProvider(decode, request, locate)], decodeImage: decode,
    glyphs: { text: () => { throw new Error("unused"); }, symbol: () => { throw new Error("unused"); }, emoji: () => { throw new Error("unused"); } },
  });
  const target = await resolver.resolve({ type: "terrain", region: "Testland", style: "terrain" }, signal());
  assert.equal(target.visual.kind, "heightfield");
  assert.equal(target.label, "Testland");
  assert.equal(target.hold, 14);
  const trace = resolver.lastTrace!;
  assert.equal(trace.targetType, "heightfield");
  assert.equal(trace.sourceType, "elevation (metres)");
  assert.equal(trace.field!.min, 0);
  assert.equal(trace.field!.max, 1);
  assert.ok(trace.field!.elevation!.max > 1200);
});

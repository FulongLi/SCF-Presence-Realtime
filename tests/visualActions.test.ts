import test from "node:test";
import assert from "node:assert/strict";
import { validateVisualAction, allowedImageURL } from "../src/visual-actions/validate";
import { VisualActionController, transitionSeconds } from "../src/visual-actions/controller";
import { createTargetPoints } from "../src/visual-actions/targets/points";
import { clockText } from "../src/visual-actions/resolve";
import { findPortrait } from "../src/visual-actions/portrait/wikimedia";
import type { MorphTarget, Raster } from "../src/visual-actions/types";

test("valid actions are accepted and normalized", () => {
  assert.deepEqual(validateVisualAction({ type: "sphere" }), { type: "sphere" });
  assert.deepEqual(validateVisualAction({ type: "clock", time: "15:42" }), { type: "clock", time: "15:42" });
  assert.deepEqual(validateVisualAction({ type: "clock" }), { type: "clock" });
  assert.deepEqual(validateVisualAction({ type: "clock", timestamp: 1_700_000_000_000 }), { type: "clock", timestamp: 1_700_000_000_000 });
  assert.deepEqual(validateVisualAction({ type: "number", value: " 42% " }), { type: "number", value: "42%" });
  for (const value of ["-3.5", "$1,200", "23°C", "3/4", "1 000 000"]) assert.ok(validateVisualAction({ type: "number", value }), value);
  assert.deepEqual(validateVisualAction({ type: "text", value: "Hello   world" }), { type: "text", value: "Hello world" });
  assert.deepEqual(validateVisualAction({ type: "text", value: "巴黎" }), { type: "text", value: "巴黎" });
  assert.deepEqual(validateVisualAction({ type: "symbol", value: "check" }), { type: "symbol", value: "check" });
  assert.deepEqual(validateVisualAction({ type: "portrait", person: "Nikola Tesla" }), { type: "portrait", person: "Nikola Tesla" });
  assert.deepEqual(validateVisualAction({ type: "portrait", person: "尼古拉·特斯拉" }), { type: "portrait", person: "尼古拉·特斯拉" });
});

test("unsupported types, extra fields, markup, scripts and arbitrary URLs are rejected", () => {
  const rejected: unknown[] = [
    null, [], "sphere", 42, { type: "model", url: "bb8.glb" }, { type: "script", value: "alert(1)" },
    { type: "sphere", extra: true }, { type: "clock", time: "25:00" }, { type: "clock", time: "3:42" },
    { type: "clock", timestamp: -1 }, { type: "clock", timestamp: 1.5 }, { type: "clock", time: "15:42", color: "red" },
    { type: "number", value: "12345678901234" }, { type: "number", value: "abc" }, { type: "number", value: 42 },
    { type: "text", value: "<img src=x onerror=alert(1)>" }, { type: "text", value: "a very long label indeed" },
    { type: "text", value: "https://evil.test" }, { type: "text", value: "bad‮text" }, { type: "text", value: "" },
    { type: "symbol", value: "skull" }, { type: "portrait" }, { type: "portrait", person: "" },
    { type: "portrait", person: "javascript:alert(1)" }, { type: "portrait", person: " Tesla" },
    { type: "portrait", imageUrl: "https://evil.test/a.jpg" }, { type: "portrait", imageUrl: "http://upload.wikimedia.org/a.jpg" },
    { type: "portrait", imageUrl: "https://upload.wikimedia.org/a.svg" }, { type: "portrait", person: "Tesla", onload: "x" },
    Object.assign(Object.create({ type: "sphere" }), {}),
  ];
  for (const value of rejected) assert.equal(validateVisualAction(value), null, JSON.stringify(value));
});

test("portrait images are limited to Wikimedia uploads over HTTPS", () => {
  for (const url of ["http://upload.wikimedia.org/a.jpg", "https://upload.wikimedia.org.evil.test/a.jpg", "https://localhost/a.jpg",
    "https://user@upload.wikimedia.org/a.jpg", "https://upload.wikimedia.org:8443/a.jpg", "https://upload.wikimedia.org/a.gif"]) {
    assert.throws(() => allowedImageURL(url), url);
  }
  assert.equal(allowedImageURL("https://upload.wikimedia.org/wikipedia/commons/7/79/Tesla.jpeg").hostname, "upload.wikimedia.org");
});

test("clock actions show the explicit time, else a local timestamp, else now", () => {
  assert.equal(clockText({ type: "clock", time: "15:42" }), "15:42");
  const date = new Date(2026, 8, 24, 7, 5);
  assert.equal(clockText({ type: "clock", timestamp: date.getTime() }), "07:05");
  assert.equal(clockText({ type: "clock" }, new Date(2026, 0, 1, 23, 59)), "23:59");
});

const target = (label: string, hold = 2): MorphTarget => ({
  raster: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) }, style: "glyph", hold, label,
});
function lifecycle() {
  const resolved: { label: string; resolve: (value: MorphTarget) => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];
  const errors: unknown[] = [];
  const controller = new VisualActionController((action, signal) => new Promise((resolve, reject) => {
    resolved.push({ label: action.type, resolve, reject, signal });
  }), error => errors.push(error));
  const run = (seconds: number) => {
    const levels: number[] = [];
    for (let i = 0; i < Math.round(seconds * 60); i++) levels.push(controller.sample(1 / 60));
    return levels;
  };
  return { controller, resolved, errors, run, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test("an action forms from the sphere, holds, and returns to the sphere smoothly", async () => {
  const h = lifecycle();
  h.controller.submit({ type: "clock", time: "15:42" });
  assert.equal(h.controller.phase, "sphere", "the sphere stays until the target is ready");
  h.resolved[0].resolve(target("15:42", 2));
  await h.settle();
  const forming = h.run(transitionSeconds.form + 0.1);
  assert.equal(h.controller.revision, 1);
  assert.equal(h.controller.phase, "holding");
  for (let i = 1; i < forming.length; i++) {
    assert.ok(forming[i] >= forming[i - 1], "monotonic formation");
    assert.ok(forming[i] - forming[i - 1] < 0.03, "no jumps");
  }
  h.run(2);
  assert.equal(h.controller.phase, "returning");
  const returning = h.run(transitionSeconds.return + 0.1);
  assert.equal(h.controller.phase, "sphere");
  assert.equal(h.controller.level, 0);
  for (let i = 1; i < returning.length; i++) assert.ok(returning[i] <= returning[i - 1] + 1e-12);
});

test("a second action returns through the sphere before the next target is loaded", async () => {
  const h = lifecycle();
  h.controller.submit({ type: "number", value: "42" });
  h.resolved[0].resolve(target("42", 30)); await h.settle();
  h.run(2);
  assert.equal(h.controller.phase, "holding");
  h.controller.submit({ type: "text", value: "Paris" });
  h.resolved[1].resolve(target("Paris", 30)); await h.settle();
  const levels: number[] = [], revisions: number[] = [];
  for (let i = 0; i < 60 * 4; i++) { levels.push(h.controller.sample(1 / 60)); revisions.push(h.controller.revision); }
  const swap = revisions.indexOf(2);
  assert.ok(swap > 0, "the next target loads");
  assert.equal(levels[swap], 0, "the buffer is replaced only at the sphere");
  assert.equal(h.controller.target?.label, "Paris");
  assert.equal(h.controller.phase, "holding");
});

test("the sphere action cancels pending work and releases the current action", async () => {
  const h = lifecycle();
  h.controller.submit({ type: "portrait", person: "Nikola Tesla" });
  h.controller.submit({ type: "sphere" });
  assert.equal(h.resolved[0].signal.aborted, true);
  h.resolved[0].resolve(target("late")); await h.settle();
  h.run(1);
  assert.equal(h.controller.phase, "sphere");
  assert.equal(h.controller.revision, 0, "a cancelled result never appears");
});

test("resolution failures leave the sphere untouched and are reported", async () => {
  const h = lifecycle();
  h.controller.submit({ type: "portrait", person: "Unknown" });
  h.resolved[0].reject(new Error("portrait-not-found")); await h.settle();
  h.run(1);
  assert.equal(h.controller.phase, "sphere");
  assert.equal(h.errors.length, 1);
});

function raster(width: number, height: number, paint: (x: number, y: number) => number): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = paint(x, y); data.set([v, v, v, v], (y * width + x) * 4);
  }
  return { width, height, data };
}

test("portrait sampling preserves image placement, bounded relief and quality prefixes", () => {
  const image = raster(32, 32, x => x < 16 ? 240 : 30);
  const style = "portrait" as const;
  const large = createTargetPoints({ raster: image, style }, 2000), small = createTargetPoints({ raster: image, style }, 500);
  assert.deepEqual(large.positions.slice(0, 1500), small.positions);
  let left = 0;
  for (let i = 0; i < small.tones.length; i++) {
    const [x, y, z] = small.positions.slice(i * 3, i * 3 + 3);
    assert.ok(Math.abs(x) <= 1.8 && Math.abs(y) <= 1.8 && Math.abs(z) < 0.13);
    if (x < 0) left++;
    assert.ok(small.tones[i] >= 0 && small.tones[i] <= 1);
  }
  assert.ok(left > 400);
});

test("glyph sampling places particles only on the shape", () => {
  // A vertical bar in the middle third of a wide raster.
  const image = raster(90, 30, x => x >= 30 && x < 60 ? 255 : 0);
  const points = createTargetPoints({ raster: image, style: "glyph" }, 3000);
  const width = Math.min(2, 3.2 / 3) * 3;
  for (let i = 0; i < 3000; i++) {
    const x = points.positions[i * 3], z = points.positions[i * 3 + 2];
    assert.ok(x >= -width / 6 - 1e-6 && x <= width / 6 + 1e-6, `x=${x}`);
    assert.ok(Math.abs(z) <= 0.08);
  }
  assert.throws(() => createTargetPoints({ raster: raster(8, 8, () => 0), style: "glyph" }, 10));
  assert.throws(() => createTargetPoints({ raster: { width: 4, height: 4, data: new Uint8ClampedArray(3) }, style: "glyph" }, 10));
});

test("portrait lookup is client-side: anonymous CORS requests, no redirects, bounded images", async () => {
  const urls: string[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); urls.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    if (url.includes("wikipedia.org")) {
      assert.match(url, /origin=\*/);
      return Response.json({ query: { pages: [{ title: "Nikola Tesla", pageimage: "Tesla.jpeg" }] } });
    }
    if (url.includes("commons.wikimedia.org")) return Response.json({ query: { pages: [{ imageinfo: [{ url: "https://upload.wikimedia.org/photo.jpeg", extmetadata: { Artist: { value: "<b>Photographer</b>" }, LicenseShortName: { value: "Public domain" } } }] }] } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
  };
  const result = await findPortrait("Nikola Tesla", new AbortController().signal, request as typeof fetch);
  assert.equal(urls.length, 3);
  assert.equal(result.author, "Photographer");
  assert.equal(result.license, "Public domain");
  assert.equal(result.image.type, "image/jpeg");
  assert.equal(result.image.size, 3);
});

test("portrait lookup refuses redirects to other hosts, wrong types and missing photos", async () => {
  const wrongHost = async (input: string | URL | Request) => String(input).includes("commons")
    ? Response.json({ query: { pages: [{ imageinfo: [{ url: "https://evil.test/photo.jpeg" }] }] } })
    : Response.json({ query: { pages: [{ title: "X", pageimage: "X.jpg" }] } });
  await assert.rejects(findPortrait("X", new AbortController().signal, wrongHost as typeof fetch));
  const html = async (input: string | URL | Request) => String(input).includes("upload")
    ? new Response("<html>", { headers: { "content-type": "text/html" } })
    : String(input).includes("commons") ? Response.json({ query: { pages: [{ imageinfo: [{ url: "https://upload.wikimedia.org/p.jpg" }] }] } })
      : Response.json({ query: { pages: [{ title: "X", pageimage: "X.jpg" }] } });
  await assert.rejects(findPortrait("X", new AbortController().signal, html as typeof fetch), /portrait-type/);
  const empty = async () => Response.json({ query: { pages: [] } });
  await assert.rejects(findPortrait("Unknown person", new AbortController().signal, empty as typeof fetch), /portrait-not-found/);
});

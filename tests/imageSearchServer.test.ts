import test from "node:test";
import assert from "node:assert/strict";
import { braveCandidates, BRAVE_IMAGES_URL, searchWebImage } from "../src/server/imageSearch";

const KEY = "brave-secret-key-123";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(9)]);
const post = (body: unknown, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/visual/image", {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const env = { BRAVE_SEARCH_API_KEY: KEY };

test("the keyed image route is off without a key, and guards origin and body", async () => {
  let called = false;
  const upstream = (async () => { called = true; return new Response(""); }) as typeof fetch;
  assert.deepEqual(await searchWebImage(post({ query: "iPhone" }), {}, upstream), { status: 503, body: { error: "not-configured" } });
  assert.equal((await searchWebImage(post({ query: "iPhone" }, "https://evil.test"), env, upstream)).status, 403);
  for (const body of ["not json", { query: "" }, { query: "https://evil.test/x.jpg" }, { query: "cat", intent: "nsfw" }, { query: "x".repeat(600) }]) {
    assert.equal((await searchWebImage(post(body), env, upstream)).status, 400, JSON.stringify(body));
  }
  assert.equal(called, false, "nothing reaches the provider without a valid request");
});

test("the key stays on the server; only Brave's own thumbnail host is ever downloaded", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const upstream = (async (input: URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith(BRAVE_IMAGES_URL)) {
      return Response.json({ results: [
        { title: "iPhone", thumbnail: { src: "https://evil.test/i.jpg" }, properties: { width: 800, height: 600 } },
        { title: "Apple iPhone 17", confidence: "high", thumbnail: { src: "https://imgs.search.brave.com/abc.jpg" }, properties: { width: 800, height: 600 } },
      ] });
    }
    if (url === "https://imgs.search.brave.com/abc.jpg") return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const result = await searchWebImage(post({ query: "iPhone 17", intent: "product" }), env, upstream);
  assert.equal(result.status, 200);
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.body instanceof Uint8Array && result.body.length === JPEG.length);
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[0].init?.headers).get("X-Subscription-Token"), KEY, "the key goes only to the search API");
  assert.match(requests[0].url, /safesearch=strict/);
  assert.equal(new Headers(requests[1].init?.headers).get("X-Subscription-Token"), null, "the key never goes to the image host");
  assert.equal(requests[1].init?.redirect, "error");
  assert.ok(!requests.some(r => r.url.includes("evil.test")));
  assert.equal(JSON.stringify(braveCandidates([{ thumbnail: { src: "https://imgs.search.brave.com/x" } }], "x")).includes(KEY), false);
});

test("the keyed image route maps upstream trouble to short errors without leaking the key", async () => {
  const failing = (async () => new Response("", { status: 500 })) as typeof fetch;
  const error = await searchWebImage(post({ query: "iPhone" }), env, failing);
  assert.deepEqual(error, { status: 502, body: { error: "upstream-error" } });
  const empty = (async () => Response.json({ results: [] })) as typeof fetch;
  assert.deepEqual(await searchWebImage(post({ query: "Qwxyzzy" }), env, empty), { status: 404, body: { error: "image-not-found" } });
  const html = (async (input: URL) => String(input).startsWith(BRAVE_IMAGES_URL)
    ? Response.json({ results: [{ title: "cat", thumbnail: { src: "https://imgs.search.brave.com/c.jpg" } }] })
    : new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  assert.deepEqual(await searchWebImage(post({ query: "cat" }), env, html), { status: 404, body: { error: "image-not-found" } });
  for (const response of [error]) assert.ok(!JSON.stringify(response).includes(KEY));
});

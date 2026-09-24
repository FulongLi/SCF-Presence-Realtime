import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionConfig, REALTIME_DEFAULTS, sessionOptionsFromEnv } from "../src/realtime/session";
import { CLIENT_SECRETS_URL, createRealtimeToken, originAllowed, safetyIdentifier } from "../src/server/realtimeToken";
import { VISUAL_TOOL_NAMES } from "../src/realtime/tools/definitions";

const KEY = "sk-test-permanent-key-never-in-browser";
const INSTALL = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const request = (body: unknown = { installationId: INSTALL }, origin: string | null = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/realtime/token", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function upstream(status = 200, body: unknown = { value: "ek_abc", expires_at: 1_900_000_000, session: {} }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(body, { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("mints an ephemeral client secret with the GA session config; the API key stays server-side", async () => {
  const { fetcher, calls } = upstream();
  const result = await createRealtimeToken(request(), { OPENAI_API_KEY: KEY }, fetcher);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { value: "ek_abc", expiresAt: 1_900_000_000, model: REALTIME_DEFAULTS.model, voice: REALTIME_DEFAULTS.voice });
  assert.ok(!JSON.stringify(result.body).includes(KEY), "the standard key is never returned");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CLIENT_SECRETS_URL);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["OpenAI-Beta"], undefined, "GA interface: no beta header");
  const payload = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(payload.expires_after, { anchor: "created_at", seconds: 60 });
  assert.equal(payload.session.type, "realtime");
  assert.equal(payload.session.model, "gpt-realtime-2.1");
  assert.equal(payload.session.audio.output.voice, "marin");
  assert.deepEqual(payload.session.audio.input.turn_detection, { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true });
  assert.deepEqual(payload.session.tools.map((tool: { name: string }) => tool.name), [...VISUAL_TOOL_NAMES]);
  assert.equal(payload.session.tool_choice, "auto");
  assert.match(payload.session.instructions, /visual body/);
  assert.equal(payload.session.audio.input.transcription, undefined, "no transcription cost unless configured");
});

test("safety identifier: a salted hash of the anonymous installation id, never the raw id", async () => {
  const { fetcher, calls } = upstream();
  await createRealtimeToken(request(), { OPENAI_API_KEY: KEY, SCF_SAFETY_ID_SALT: "pepper" }, fetcher);
  const header = (calls[0].init.headers as Record<string, string>)["OpenAI-Safety-Identifier"];
  assert.match(header, /^scf-[0-9a-f]{40}$/);
  assert.ok(!header.includes(INSTALL));
  assert.equal(header, await safetyIdentifier(INSTALL, "pepper"), "stable per installation");
  assert.notEqual(header, await safetyIdentifier(INSTALL, "other-salt"), "unlinkable across deployments");
  assert.equal(await safetyIdentifier("not a valid id!", "x"), undefined);
  const without = upstream();
  await createRealtimeToken(request({}), { OPENAI_API_KEY: KEY }, without.fetcher);
  assert.equal((without.calls[0].init.headers as Record<string, string>)["OpenAI-Safety-Identifier"], undefined);
});

test("model, voice, turn detection and transcription are configurable; bad values fall back", () => {
  const options = sessionOptionsFromEnv({
    OPENAI_REALTIME_MODEL: "gpt-realtime-2", OPENAI_REALTIME_VOICE: "cedar",
    OPENAI_REALTIME_TURN_DETECTION: "server_vad", OPENAI_REALTIME_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
  });
  const session = buildSessionConfig(options);
  assert.equal(session.model, "gpt-realtime-2");
  assert.equal(session.audio.output.voice, "cedar");
  assert.equal(session.audio.input.turn_detection.type, "server_vad");
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.deepEqual(session.audio.input.transcription, { model: "gpt-4o-mini-transcribe" });
  const fallback = sessionOptionsFromEnv({ OPENAI_REALTIME_MODEL: "x\"; drop", OPENAI_REALTIME_VOICE: "", OPENAI_REALTIME_TURN_DETECTION: "push" });
  assert.deepEqual([fallback.model, fallback.voice, fallback.turnDetection], ["gpt-realtime-2.1", "marin", "semantic_vad"]);
});

test("refuses without a configured key, from foreign origins, and for malformed bodies", async () => {
  const { fetcher, calls } = upstream();
  assert.deepEqual(await createRealtimeToken(request(), {}, fetcher), { status: 503, body: { error: "not-configured" } });
  assert.equal((await createRealtimeToken(request(undefined, "https://evil.example"), { OPENAI_API_KEY: KEY }, fetcher)).status, 403);
  assert.equal((await createRealtimeToken(request(undefined, null), { OPENAI_API_KEY: KEY }, fetcher)).status, 403);
  assert.equal((await createRealtimeToken(request("{not json"), { OPENAI_API_KEY: KEY }, fetcher)).status, 400);
  assert.equal((await createRealtimeToken(request("x".repeat(5000)), { OPENAI_API_KEY: KEY }, fetcher)).status, 400);
  assert.equal(calls.length, 0, "nothing reaches OpenAI");
  assert.ok(originAllowed(request(undefined, "https://presence.example"), "https://presence.example/"));
});

test("upstream failures map to stable codes without leaking the key", async () => {
  const cases: [number, string][] = [[401, "invalid-api-key"], [429, "rate-limited"], [500, "upstream-error"], [400, "upstream-rejected"]];
  for (const [status, code] of cases) {
    const { fetcher } = upstream(status, { error: { message: `boom ${KEY.slice(0, 3)}` } });
    const result = await createRealtimeToken(request(), { OPENAI_API_KEY: KEY, NODE_ENV: "production" }, fetcher);
    assert.equal(result.body.error, code);
    assert.equal(result.body.detail, undefined, "no upstream detail in production");
    assert.ok(!JSON.stringify(result.body).includes(KEY));
  }
  const unreachable = (async () => { throw new TypeError("network"); }) as typeof fetch;
  assert.deepEqual(await createRealtimeToken(request(), { OPENAI_API_KEY: KEY }, unreachable), { status: 502, body: { error: "upstream-unreachable" } });
  const empty = upstream(200, {});
  assert.equal((await createRealtimeToken(request(), { OPENAI_API_KEY: KEY }, empty.fetcher)).body.error, "upstream-error");
});

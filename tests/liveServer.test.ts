import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_BACKEND_INSTRUCTIONS, LIVE_VOICE_INSTRUCTIONS } from "../src/live/instructions";
import { buildLiveSessionConfig, LIVE_DEFAULTS, liveOptionsFromEnv } from "../src/live/session";
import { PRESENCE_INSTRUCTIONS } from "../src/realtime/instructions";
import { buildSessionConfig, sessionOptionsFromEnv } from "../src/realtime/session";
import { createLiveSession, LIVE_SESSIONS_URL, validOffer } from "../src/server/liveSession";
import { VISUAL_TOOL_NAMES, visualTools } from "../src/voice/tools/definitions";
import { VISUAL_TOOL_RULES } from "../src/voice/visualGuidance";

const KEY = "sk-test-permanent-key-never-in-browser";
const INSTALL = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=candidate:1 1 udp 1 192.0.2.1 5000 typ host\r\n";
const request = (body: unknown = { sdp: OFFER, installationId: INSTALL }, origin: string | null = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/live/session", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function upstream(status = 201, body: unknown = { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(body, { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("creates a GPT-Live WebRTC session with the same OPENAI_API_KEY; only the answer and metadata reach the browser", async () => {
  const { fetcher, calls } = upstream();
  const result = await createLiveSession(request(), { OPENAI_API_KEY: KEY }, fetcher);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { sdp: "v=0\r\nanswer", sessionId: "live_123", model: "gpt-live-1", backendModel: "gpt-5.6-terra", voice: "marin" });
  assert.ok(!JSON.stringify(result.body).includes(KEY), "the API key is never returned");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LIVE_SESSIONS_URL);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.match(headers["OpenAI-Safety-Identifier"], /^scf-[0-9a-f]{40}$/);
  const payload = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(payload.transport, { type: "webrtc", sdp: OFFER }, "the browser's offer is forwarded unchanged");
  assert.equal(payload.session.model, "gpt-live-1");
  assert.equal(payload.session.audio.format, undefined, "WebRTC negotiates audio; no audio.format");
  assert.equal(payload.session.delegation.type, "responses");
  assert.deepEqual(payload.session.client.data_channel.allowed_client_events, ["response.item.create", "response.create", "session.close"]);
  assert.equal(payload.transport.type, "webrtc");
});

test("the Live backend registers the canonical visual tools; prompts are split, not copied", () => {
  const config = buildLiveSessionConfig(liveOptionsFromEnv({}));
  const responses = config.delegation.responses;
  assert.equal(responses.model, LIVE_DEFAULTS.backendModel);
  assert.equal(responses.tools, visualTools, "the same tool definitions object as Realtime: no second schema");
  assert.deepEqual(responses.tools.map(tool => tool.name), [...VISUAL_TOOL_NAMES]);
  assert.equal(buildSessionConfig(sessionOptionsFromEnv({})).tools, visualTools);
  assert.equal(responses.tool_choice, "auto");
  assert.equal(responses.parallel_tool_calls, false);
  assert.equal(responses.reasoning, undefined, "reasoning effort is left to the model unless configured");
  assert.equal(config.instructions, LIVE_VOICE_INSTRUCTIONS);
  assert.equal(responses.instructions, LIVE_BACKEND_INSTRUCTIONS);
  assert.ok(LIVE_VOICE_INSTRUCTIONS.length < PRESENCE_INSTRUCTIONS.length * 1.6 && !LIVE_VOICE_INSTRUCTIONS.includes(VISUAL_TOOL_RULES),
    "the voice prompt stays conversational; the detailed tool rules live in the backend");
  for (const heading of ["Backchannel policy:", "Interruption policy:", "Delegation policy:"]) assert.ok(LIVE_VOICE_INSTRUCTIONS.includes(heading));
  assert.ok(LIVE_BACKEND_INSTRUCTIONS.includes(VISUAL_TOOL_RULES) && PRESENCE_INSTRUCTIONS.includes(VISUAL_TOOL_RULES),
    "Realtime and the Live backend share the visual rules word for word");
  for (const name of VISUAL_TOOL_NAMES) assert.ok(LIVE_BACKEND_INSTRUCTIONS.includes(name));
  assert.ok(LIVE_BACKEND_INSTRUCTIONS.includes("Spirit Connect logo"));
});

test("Live configuration from the environment: models are configurable, invalid values fall back", () => {
  assert.deepEqual(liveOptionsFromEnv({}), { model: "gpt-live-1", backendModel: "gpt-5.6-terra", voice: "marin", reasoningEffort: undefined });
  assert.deepEqual(liveOptionsFromEnv({ OPENAI_LIVE_MODEL: "gpt-live-1", OPENAI_LIVE_BACKEND_MODEL: " gpt-5.6-luna ", OPENAI_LIVE_VOICE: "quartz", OPENAI_LIVE_BACKEND_REASONING: "LOW" }),
    { model: "gpt-live-1", backendModel: "gpt-5.6-luna", voice: "quartz", reasoningEffort: "low" });
  assert.deepEqual(liveOptionsFromEnv({ OPENAI_LIVE_MODEL: "x\", \"tools\": []", OPENAI_LIVE_BACKEND_REASONING: "max" }),
    { model: "gpt-live-1", backendModel: "gpt-5.6-terra", voice: "marin", reasoningEffort: undefined });
  const tuned = buildLiveSessionConfig({ ...liveOptionsFromEnv({}), reasoningEffort: "low" });
  assert.deepEqual(tuned.delegation.responses.reasoning, { effort: "low" });
});

test("refusals: no key, foreign origin, missing or implausible offer; upstream errors map to stable codes", async () => {
  const ok = upstream();
  assert.deepEqual(await createLiveSession(request(), {}, ok.fetcher), { status: 503, body: { error: "not-configured" } });
  assert.equal((await createLiveSession(request(undefined, "https://evil.example"), { OPENAI_API_KEY: KEY }, ok.fetcher)).status, 403);
  assert.equal((await createLiveSession(request(undefined, null), { OPENAI_API_KEY: KEY }, ok.fetcher)).status, 403);
  for (const body of [{}, { sdp: "" }, { sdp: "hello" }, { sdp: 42 }, "not json", { sdp: `v=0\n${"a".repeat(70_000)}` }]) {
    assert.deepEqual(await createLiveSession(request(body), { OPENAI_API_KEY: KEY }, ok.fetcher), { status: 400, body: { error: "bad-request" } });
  }
  assert.equal(ok.calls.length, 0, "nothing reaches OpenAI without a valid request");
  assert.ok(validOffer("v=0\r\ns=-\r\n") && !validOffer("v=1\r\n") && !validOffer("v=0\r\n\0"));
  const env = { OPENAI_API_KEY: KEY, NODE_ENV: "production" };
  assert.deepEqual((await createLiveSession(request(), env, upstream(401, { error: { message: "bad key" } }).fetcher)).body, { error: "invalid-api-key" });
  assert.deepEqual(await createLiveSession(request(), env, upstream(429, {}).fetcher), { status: 429, body: { error: "rate-limited" } });
  assert.deepEqual((await createLiveSession(request(), env, upstream(400, { error: { message: "unknown model" } }).fetcher)).body, { error: "upstream-rejected" });
  assert.deepEqual((await createLiveSession(request(), env, upstream(500, {}).fetcher)).body, { error: "upstream-error" });
  assert.deepEqual((await createLiveSession(request(), env, upstream(201, { session: { id: "x" } }).fetcher)).body, { error: "upstream-error" });
  const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.deepEqual((await createLiveSession(request(), env, down)).body, { error: "upstream-unreachable" });
  const detail = await createLiveSession(request(), { OPENAI_API_KEY: KEY }, upstream(400, { error: { message: "unknown model" } }).fetcher);
  assert.deepEqual(detail.body, { error: "upstream-rejected", detail: "unknown model" }, "details only outside production");
});

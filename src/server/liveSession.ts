import { buildLiveSessionConfig, liveOptionsFromEnv, type LiveSessionConfig } from "../live/session";
import { originAllowed, safetyIdentifier } from "./realtimeToken";

/**
 * Server-side creation of GPT-Live WebRTC sessions (POST /v1/live/sessions).
 *
 *   browser ── POST /api/live/session { sdp } ──► SCF server ── OPENAI_API_KEY ──► OpenAI Live
 *   browser ◄──────── { sdp: answer, sessionId, model, backendModel, voice } ─────────────┘
 *
 * The same OPENAI_API_KEY as the Realtime route; it is used only here and never appears in a response.
 * The session (models, prompts, tools, frontend permissions) is fixed server-side. Audio never passes
 * through this server: after the SDP exchange the browser's peer connection talks to OpenAI directly.
 * This flow is separate from the Realtime ephemeral-secret flow in realtimeToken.ts.
 */
export const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
/** A complete (non-trickle) browser offer with its ICE candidates fits comfortably in this. */
const MAX_BODY_BYTES = 64 * 1024;

export interface LiveSessionRequest {
  session: LiveSessionConfig;
  transport: { type: "webrtc"; sdp: string };
}

export interface LiveSessionResponse { status: number; body: Record<string, unknown> }

export function liveSessionRequest(env: Record<string, string | undefined>, sdp: string): LiveSessionRequest {
  return { session: buildLiveSessionConfig(liveOptionsFromEnv(env)), transport: { type: "webrtc", sdp } };
}

/** Only a plausible SDP offer is forwarded: text starting with the protocol version line, no NULs. */
export function validOffer(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BODY_BYTES && /^v=0\r?\n/.test(value) && !value.includes("\0");
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES || !text.trim()) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export async function createLiveSession(
  request: Request,
  env: Record<string, string | undefined>,
  upstream: typeof fetch = fetch,
): Promise<LiveSessionResponse> {
  const fail = (status: number, error: string, detail?: string): LiveSessionResponse =>
    ({ status, body: detail && env.NODE_ENV !== "production" ? { error, detail } : { error } });
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return fail(503, "not-configured");
  if (!originAllowed(request, env.SCF_ALLOWED_ORIGINS)) return fail(403, "forbidden-origin");
  const body = await readBody(request);
  if (!body || !validOffer(body.sdp)) return fail(400, "bad-request");

  const payload = liveSessionRequest(env, body.sdp);
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const safetyId = await safetyIdentifier(body.installationId, env.SCF_SAFETY_ID_SALT);
  if (safetyId) headers["OpenAI-Safety-Identifier"] = safetyId;

  let response: Response;
  try {
    response = await upstream(LIVE_SESSIONS_URL, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
  } catch {
    return fail(502, "upstream-unreachable");
  }
  const data = await response.json().catch(() => null) as {
    session?: { id?: unknown }; transport?: { sdp?: unknown }; error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    const detail = typeof data?.error?.message === "string" ? data.error.message.slice(0, 300) : undefined;
    if (response.status === 401) return fail(502, "invalid-api-key");
    if (response.status === 429) return fail(429, "rate-limited", detail);
    if (response.status >= 500) return fail(502, "upstream-error", detail);
    return fail(502, "upstream-rejected", detail);
  }
  const sdp = data?.transport?.sdp;
  if (typeof sdp !== "string" || !sdp) return fail(502, "upstream-error");
  return {
    status: 200,
    body: {
      sdp,
      sessionId: typeof data?.session?.id === "string" ? data.session.id : undefined,
      model: payload.session.model,
      backendModel: payload.session.delegation.responses.model,
      voice: payload.session.audio.output.voice,
    },
  };
}

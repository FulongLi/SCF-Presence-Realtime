import { buildSessionConfig, sessionOptionsFromEnv, type RealtimeSessionConfig } from "../realtime/session";

/**
 * Server-side minting of ephemeral Realtime client secrets (GA: POST /v1/realtime/client_secrets).
 *
 *   browser ── POST /api/realtime/token ──► SCF server ── OPENAI_API_KEY ──► OpenAI
 *   browser ◄──────── { value: "ek_…" } ──────────────────────────────────────┘
 *
 * The standard API key is used only here and never appears in a response. The session (model, voice,
 * instructions, tools, turn detection) is fixed server-side and bound to the secret. No audio,
 * transcripts or conversation state pass through this server.
 */
export const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
/** The secret is only needed for the immediate SDP exchange, so it lives just long enough for that. */
export const CLIENT_SECRET_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 1024;
const INSTALLATION = /^[a-z0-9-]{16,64}$/;

export interface ClientSecretRequest {
  expires_after: { anchor: "created_at"; seconds: number };
  session: RealtimeSessionConfig;
}

export interface TokenResponse { status: number; body: Record<string, unknown> }

export function clientSecretRequest(env: Record<string, string | undefined>): ClientSecretRequest {
  return {
    expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_SECONDS },
    session: buildSessionConfig(sessionOptionsFromEnv(env)),
  };
}

/**
 * Only the app's own origin (and explicitly configured ones) may mint secrets, so other sites cannot
 * spend the key through a visitor's browser. Non-browser callers can forge Origin; deployments that
 * need real access control should add authentication in front of this route.
 */
export function originAllowed(request: Request, extra: string | undefined): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set<string>([new URL(request.url).origin]);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() || new URL(request.url).protocol.replace(":", "");
    allowed.add(`${proto}://${host}`);
  }
  for (const entry of (extra ?? "").split(",")) {
    const value = entry.trim().replace(/\/$/, "");
    if (value) allowed.add(value);
  }
  return allowed.has(origin);
}

/**
 * OpenAI recommends a stable, privacy-preserving per-user safety identifier for ephemeral sessions,
 * set server-side. Without accounts, SCF hashes the browser's random installation id with a server salt.
 */
export async function safetyIdentifier(installationId: unknown, salt: string | undefined): Promise<string | undefined> {
  if (typeof installationId !== "string" || !INSTALLATION.test(installationId)) return undefined;
  const bytes = new TextEncoder().encode(`${salt || "scf-presence-realtime"}:${installationId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `scf-${Array.from(digest.subarray(0, 20), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return null;
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export async function createRealtimeToken(
  request: Request,
  env: Record<string, string | undefined>,
  upstream: typeof fetch = fetch,
): Promise<TokenResponse> {
  const fail = (status: number, error: string, detail?: string): TokenResponse =>
    ({ status, body: detail && env.NODE_ENV !== "production" ? { error, detail } : { error } });
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return fail(503, "not-configured");
  if (!originAllowed(request, env.SCF_ALLOWED_ORIGINS)) return fail(403, "forbidden-origin");
  const body = await readBody(request);
  if (!body) return fail(400, "bad-request");

  const payload = clientSecretRequest(env);
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const safetyId = await safetyIdentifier(body.installationId, env.SCF_SAFETY_ID_SALT);
  if (safetyId) headers["OpenAI-Safety-Identifier"] = safetyId;

  let response: Response;
  try {
    response = await upstream(CLIENT_SECRETS_URL, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
  } catch {
    return fail(502, "upstream-unreachable");
  }
  const data = await response.json().catch(() => null) as { value?: unknown; expires_at?: unknown; error?: { message?: unknown } } | null;
  if (!response.ok) {
    const detail = typeof data?.error?.message === "string" ? data.error.message.slice(0, 300) : undefined;
    if (response.status === 401) return fail(502, "invalid-api-key");
    if (response.status === 429) return fail(429, "rate-limited", detail);
    if (response.status >= 500) return fail(502, "upstream-error", detail);
    return fail(502, "upstream-rejected", detail);
  }
  if (typeof data?.value !== "string" || !data.value) return fail(502, "upstream-error");
  return {
    status: 200,
    body: {
      value: data.value,
      expiresAt: typeof data.expires_at === "number" ? data.expires_at : undefined,
      model: payload.session.model,
      voice: payload.session.audio.output.voice,
    },
  };
}

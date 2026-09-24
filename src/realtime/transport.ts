import { RealtimeConnectError, type PeerLike, type RealtimeEnvironment, type RealtimeToken } from "./client";
import { installationId } from "./identity";

/** OpenAI's GA WebRTC endpoint: the browser posts its SDP offer here with the ephemeral key. */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const TOKEN_PATH = "/api/realtime/token";

/** Server error codes that no amount of retrying will fix. */
const PERMANENT = new Set(["not-configured", "forbidden-origin", "bad-request", "rate-limited", "invalid-api-key", "upstream-rejected"]);

async function fetchToken(signal: AbortSignal): Promise<RealtimeToken> {
  let response: Response;
  try {
    response = await fetch(TOKEN_PATH, {
      method: "POST", signal, cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: installationId() }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RealtimeConnectError("token-unreachable", true);
  }
  const body = await response.json().catch(() => null) as Partial<RealtimeToken> & { error?: string } | null;
  if (!response.ok || !body?.value) {
    const code = typeof body?.error === "string" ? body.error : `token-http-${response.status}`;
    throw new RealtimeConnectError(code, !PERMANENT.has(code) && response.status >= 500);
  }
  return { value: body.value, expiresAt: body.expiresAt, model: body.model ?? "unknown", voice: body.voice ?? "unknown" };
}

async function exchangeSdp(offer: string, token: RealtimeToken, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(REALTIME_CALLS_URL, {
      method: "POST", signal, body: offer, credentials: "omit", referrerPolicy: "no-referrer",
      headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new RealtimeConnectError("realtime-unreachable", true);
  }
  // 401: the ephemeral secret expired before use — a fresh one fixes it. Other 4xx are configuration.
  if (!response.ok) throw new RealtimeConnectError(`sdp-http-${response.status}`, response.status >= 500 || response.status === 401 || response.status === 429);
  return response.text();
}

export const browserEnvironment: RealtimeEnvironment = {
  fetchToken,
  exchangeSdp,
  createPeer: () => new RTCPeerConnection() as unknown as PeerLike,
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};

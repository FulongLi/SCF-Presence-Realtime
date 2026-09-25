import { installationId } from "../realtime/identity";
import { LiveConnectError, type LiveEnvironment, type LivePeerLike, type LiveSessionAnswer } from "./client";

/**
 * GPT-Live WebRTC in the browser: the SDP offer goes to SCF's own server route, which creates the session
 * with OPENAI_API_KEY (POST /v1/live/sessions) and returns only the SDP answer and session metadata.
 * Unlike the Realtime path there is no ephemeral client secret: the browser never talks to OpenAI's HTTP
 * API and never holds any credential.
 */
export const LIVE_SESSION_PATH = "/api/live/session";

/** Server error codes that no amount of retrying will fix. */
const PERMANENT = new Set(["not-configured", "forbidden-origin", "bad-request", "rate-limited", "invalid-api-key", "upstream-rejected"]);

async function createSession(offer: string, signal: AbortSignal): Promise<LiveSessionAnswer> {
  let response: Response;
  try {
    response = await fetch(LIVE_SESSION_PATH, {
      method: "POST", signal, cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: offer, installationId: installationId() }),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new LiveConnectError("session-unreachable", true);
  }
  const body = await response.json().catch(() => null) as Partial<LiveSessionAnswer> & { error?: string } | null;
  if (!response.ok || typeof body?.sdp !== "string" || !body.sdp) {
    const code = typeof body?.error === "string" ? body.error : `session-http-${response.status}`;
    throw new LiveConnectError(code, !PERMANENT.has(code) && response.status >= 500);
  }
  return {
    sdp: body.sdp, sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    model: body.model ?? "unknown", backendModel: body.backendModel ?? "unknown", voice: body.voice ?? "unknown",
  };
}

export const browserLiveEnvironment: LiveEnvironment = {
  createSession,
  createPeer: () => new RTCPeerConnection() as unknown as LivePeerLike,
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};

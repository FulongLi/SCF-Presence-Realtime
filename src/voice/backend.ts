/**
 * Which protocol carries the voice conversation. Both backends drive the same body: the same microphone,
 * AssistantAudio, PresenceEngine, ToolExecutor, Visual Resolver and particle system.
 *
 * - realtime: the OpenAI Realtime API (one model listens, speaks and selects tools). The stable baseline.
 * - live: GPT-Live (full-duplex voice) delegating reasoning and tool selection to a Responses backend.
 */
export const VOICE_BACKENDS = ["realtime", "live"] as const;
export type VoiceBackend = typeof VOICE_BACKENDS[number];
export const DEFAULT_VOICE_BACKEND: VoiceBackend = "realtime";

export const VOICE_BACKEND_LABELS: Record<VoiceBackend, string> = { realtime: "Realtime", live: "GPT-Live" };

export const isVoiceBackend = (value: unknown): value is VoiceBackend =>
  typeof value === "string" && (VOICE_BACKENDS as readonly string[]).includes(value);

/** Reads a configured value (e.g. SCF_VOICE_BACKEND); anything unknown is ignored. */
export function parseVoiceBackend(value: string | null | undefined): VoiceBackend | null {
  const normalized = value?.trim().toLowerCase();
  return isVoiceBackend(normalized) ? normalized : null;
}

/**
 * The backend for this page: `?voice=realtime|live` (for A/B testing) → SCF_VOICE_BACKEND → realtime.
 * The query parameter only chooses between the two server-configured backends; it carries no secrets.
 */
export function resolveVoiceBackend(search: string | URLSearchParams | null | undefined, configured?: string | null): VoiceBackend {
  const params = typeof search === "string" || search === undefined || search === null ? new URLSearchParams(search ?? "") : search;
  return parseVoiceBackend(params.get("voice")) ?? parseVoiceBackend(configured) ?? DEFAULT_VOICE_BACKEND;
}

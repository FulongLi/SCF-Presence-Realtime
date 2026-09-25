import { validateVisualAction } from "../visual-actions/validate";
import { fetchImage, fetchJSON, overlap, type Fetcher } from "../visual-resolver/net";
import { rankCandidates } from "../visual-resolver/providers/rank";
import type { ImageCandidate } from "../visual-resolver/types";
import { originAllowed } from "./realtimeToken";

/**
 * Optional server-side image search (POST /api/visual/image) for providers that need a secret key.
 * Today: Brave Search's image API (BRAVE_SEARCH_API_KEY). The key is read only here, at request time.
 *
 *   browser ── { query, intent } ──► SCF server ── key ──► api.search.brave.com (search)
 *   browser ◄──── image bytes ───── SCF server ◄────────── imgs.search.brave.com (thumbnail)
 *
 * Not an open proxy: the server only downloads thumbnails from Brave's own image host, with the same
 * guards as the browser (HTTPS, no redirects, timeouts, byte limit, MIME and magic-byte checks), and
 * returns nothing but image bytes. Without a key it answers 503 and the browser stops asking.
 */
export const BRAVE_IMAGES_URL = "https://api.search.brave.com/res/v1/images/search";
const SEARCH_HOST = "api.search.brave.com";
const THUMBNAIL_HOST = "imgs.search.brave.com";
const MAX_BODY_BYTES = 512;

type BraveResult = {
  title?: string; url?: string; source?: string; confidence?: string;
  thumbnail?: { src?: string; width?: number; height?: number };
  properties?: { width?: number; height?: number };
};

export interface ImageRouteResponse { status: number; body: Uint8Array | Record<string, unknown>; mime?: string }

/** Brave results → ranked candidates. Only thumbnails on Brave's own image host are considered. */
export function braveCandidates(results: BraveResult[], query: string): ImageCandidate[] {
  const confidence: Record<string, number> = { high: 1, medium: 0.85, low: 0.7 };
  return results.flatMap((result, index): ImageCandidate[] => {
    const src = result.thumbnail?.src;
    if (!src) return [];
    let url: URL;
    try { url = new URL(src); } catch { return []; }
    if (url.protocol !== "https:" || url.hostname !== THUMBNAIL_HOST || url.port || url.username) return [];
    const title = (result.title ?? "").slice(0, 200);
    // Web titles are page titles, so a correct image often shares few words with the query.
    const relevance = Math.max(0.5, overlap(query, title)) * (confidence[result.confidence ?? ""] ?? 0.85) * (1 - Math.min(10, index) * 0.02);
    return [{
      provider: "web", url: url.href, title, relevance,
      width: result.properties?.width || result.thumbnail?.width, height: result.properties?.height || result.thumbnail?.height,
      pageUrl: result.url,
    }];
  });
}

export async function searchWebImage(request: Request, env: Record<string, string | undefined>, upstream: Fetcher = fetch): Promise<ImageRouteResponse> {
  const fail = (status: number, error: string): ImageRouteResponse => ({ status, body: { error } });
  const key = env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) return fail(503, "not-configured");
  if (!originAllowed(request, env.SCF_ALLOWED_ORIGINS)) return fail(403, "forbidden-origin");
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return fail(400, "bad-request");
  let body: { query?: unknown; intent?: unknown };
  try { body = JSON.parse(text) as typeof body; } catch { return fail(400, "bad-request"); }
  const action = validateVisualAction({ type: "image", query: body?.query, ...(body?.intent === undefined ? {} : { intent: body.intent }) });
  if (!action || action.type !== "image") return fail(400, "bad-request");

  const signal = AbortSignal.timeout(12_000);
  const url = new URL(BRAVE_IMAGES_URL);
  url.search = new URLSearchParams({ q: action.query, count: "20", safesearch: "strict" }).toString();
  let results: BraveResult[];
  try {
    const { data } = await fetchJSON<{ results?: BraveResult[] }>(url, {
      hosts: [SEARCH_HOST], signal, request: upstream,
      init: { headers: { Accept: "application/json", "X-Subscription-Token": key } },
    });
    results = Array.isArray(data.results) ? data.results.slice(0, 40) : [];
  } catch {
    return fail(502, "upstream-error");
  }
  for (const candidate of rankCandidates(braveCandidates(results, action.query), action.query, action.intent ?? "general").slice(0, 3)) {
    try {
      const { blob } = await fetchImage(candidate.url, { hosts: [THUMBNAIL_HOST], signal, request: upstream });
      return { status: 200, body: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
    } catch { if (signal.aborted) break; }
  }
  return fail(404, "image-not-found");
}

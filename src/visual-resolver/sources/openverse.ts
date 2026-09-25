import { fetchJSON, HOSTS, overlap, type Fetcher } from "../net";
import type { ImageCandidate, ImageProvider } from "../types";

/**
 * Openverse (https://openverse.org): a keyless, CORS-enabled search over hundreds of millions of openly
 * licensed images (Flickr, museums, Wikimedia and more). Only the query text is sent, anonymously.
 * Images are fetched through Openverse's own thumbnail endpoint, so every byte comes from one
 * allowlisted host whatever site the original lives on. Anonymous use is rate-limited by Openverse.
 */
type OpenverseResult = {
  id: string; title?: string; width?: number; height?: number; license?: string; provider?: string;
  foreign_landing_url?: string; tags?: { name: string }[]; mature?: boolean;
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function openverseProvider(request?: Fetcher): ImageProvider {
  return {
    name: "openverse",
    async search(query, intent, signal) {
      const url = new URL(`https://${HOSTS.openverse}/v1/images/`);
      url.search = new URLSearchParams({ q: intent === "map" ? `${query} map` : query, page_size: "20", mature: "false" }).toString();
      const { data } = await fetchJSON<{ results?: OpenverseResult[] }>(url, { hosts: [HOSTS.openverse], signal, request });
      return (data.results ?? []).flatMap((result, index): ImageCandidate[] => {
        if (!ID.test(result.id) || result.mature) return [];
        const title = (result.title ?? "").slice(0, 200);
        const tags = (result.tags ?? []).slice(0, 40).map(tag => tag.name).join(" ");
        const relevance = (overlap(query, title) * 0.6 + overlap(query, `${title} ${tags}`) * 0.4) * (1 - Math.min(15, index) * 0.02);
        return [{
          provider: "openverse", url: `https://${HOSTS.openverse}/v1/images/${result.id}/thumb/`, title,
          width: result.width || undefined, height: result.height || undefined, mime: "image/jpeg", relevance,
          pageUrl: result.foreign_landing_url, license: result.license ? `${result.license} (${result.provider ?? "openverse"})` : undefined,
        }];
      });
    },
  };
}

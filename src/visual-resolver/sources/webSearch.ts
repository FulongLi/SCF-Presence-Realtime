import { safeFetch, sniffImage, type Fetcher } from "../net";
import { ResolveError, type ImageProvider } from "../types";

/**
 * Optional web-scale image search through SCF's own server route (POST /api/visual/image). The route
 * holds the provider key (BRAVE_SEARCH_API_KEY), searches, picks and downloads one image itself and
 * returns only its bytes, so the browser never sees a key or talks to an arbitrary image host.
 * Without a key the route answers 503 once and the provider is skipped for the rest of the page.
 */
export const WEB_IMAGE_ROUTE = "/api/visual/image";

export function webSearchProvider(base: () => string | undefined, request?: Fetcher): ImageProvider {
  let configured = true;
  return {
    name: "web",
    async search(query, intent, signal) {
      const origin = base();
      if (!configured || !origin) throw new ResolveError("not-configured");
      let fetched;
      try {
        fetched = await safeFetch(WEB_IMAGE_ROUTE, {
          hosts: [], base: origin, signal, request, mimes: ["image/jpeg", "image/png", "image/webp"], maxBytes: 6 * 1024 * 1024,
          timeoutMs: 12_000,
          init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, intent }) },
          referrer: "same-origin",
        });
      } catch (error) {
        if (error instanceof ResolveError && error.message === "http-503") { configured = false; throw new ResolveError("not-configured"); }
        if (error instanceof ResolveError && error.message === "http-404") return [];
        throw error;
      }
      const mime = sniffImage(fetched.bytes);
      if (!mime) throw new ResolveError("type");
      const blob = new Blob([fetched.bytes as BlobPart], { type: mime });
      return [{ provider: "web", url: fetched.url, title: query, relevance: 0.8, mime, load: async () => blob }];
    },
  };
}

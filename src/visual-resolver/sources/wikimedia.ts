import type { ImageIntent } from "../../visual-actions/types";
import { fetchJSON, HOSTS, overlap, type Fetcher } from "../net";
import type { ImageCandidate, ImageProvider } from "../types";

/**
 * Wikimedia through its public, anonymous CORS API (`origin=*`). Only the query text is sent.
 * Two providers share this source:
 * - wikipedia: the freely licensed lead image of the article that best matches the query
 *   (people, vehicles, products, places — anything with an article);
 * - commons: a Wikimedia Commons file search (broad, freely licensed photos, maps and drawings).
 */
type WikiPage = {
  title: string; index?: number; pageimage?: string; pageprops?: { disambiguation?: string };
  thumbnail?: { source: string; width: number; height: number };
  imageinfo?: { url: string; thumburl?: string; thumbwidth?: number; thumbheight?: number; width?: number; height?: number;
    mime?: string; thumbmime?: string; descriptionurl?: string }[];
};
type WikiData = { query?: { pages?: WikiPage[] }; error?: unknown };

/** Wikimedia's thumbnail host now serves standard widths only; 960 is one of them. */
export const THUMB_WIDTH = 960;
const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

export function wikiLanguage(text: string) {
  if (/[가-힯]/u.test(text)) return "ko";
  if (/[぀-ヿ]/u.test(text)) return "ja";
  return CJK.test(text) ? "zh" : "en";
}

async function wiki(host: string, params: Record<string, string>, signal: AbortSignal, request?: Fetcher) {
  const url = new URL(`https://${host}/w/api.php`);
  url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", ...params }).toString();
  const { data, ms } = await fetchJSON<WikiData>(url, { hosts: [HOSTS.wikipedia, HOSTS.commons], signal, request, maxBytes: 1024 * 1024 });
  if (data.error) throw new Error("provider-error");
  return { pages: data.query?.pages ?? [], ms };
}

const mimeFromURL = (url: string) => {
  const path = url.split("?")[0].toLowerCase();
  if (/\.jpe?g$/.test(path)) return "image/jpeg";
  if (/\.png$/.test(path)) return "image/png";
  if (/\.webp$/.test(path)) return "image/webp";
  return undefined;
};
const fileTitle = (title: string) => title.replace(/^File:/, "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ");

/** Lead images of Wikipedia articles: the exact title (following redirects) first, then a search. */
export function wikipediaProvider(request?: Fetcher): ImageProvider {
  return {
    name: "wikipedia",
    async search(query, intent, signal) {
      const host = `${wikiLanguage(query)}.wikipedia.org`;
      const lookup = { prop: "pageimages|pageprops", piprop: "name|thumbnail", pithumbsize: String(THUMB_WIDTH), pilicense: "free" };
      const usable = (page: WikiPage) => page.thumbnail && page.pageprops?.disambiguation === undefined;
      const toCandidate = (page: WikiPage, relevance: number): ImageCandidate => ({
        provider: "wikipedia", url: page.thumbnail!.source, title: page.title,
        width: page.thumbnail!.width, height: page.thumbnail!.height, mime: mimeFromURL(page.thumbnail!.source),
        relevance, pageUrl: `https://${host}/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
        license: "free (Wikimedia Commons)",
      });
      const exact = await wiki(host, { titles: query, redirects: "1", ...lookup }, signal, request);
      const page = exact.pages.find(usable);
      if (page) return [toCandidate(page, 1)];
      // A search is only trusted when the article title shares most of the query's words, so a
      // descriptive query ("futuristic concept car") does not pick an unrelated article's photo.
      const found = await wiki(host, { generator: "search", gsrsearch: query, gsrnamespace: "0", gsrlimit: "5", ...lookup }, signal, request);
      const minimum = intent === "reference" || intent === "general" ? 0.6 : 0.5;
      return found.pages.filter(p => usable(p) && overlap(query, p.title) >= minimum)
        .map(p => toCandidate(p, overlap(query, p.title) * (1 - Math.min(4, (p.index ?? 5) - 1) * 0.06)))
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 3);
    },
  };
}

/** Wikimedia Commons file search. Maps may be drawings (SVG); their thumbnails are rasterized PNGs. */
export function commonsProvider(request?: Fetcher): ImageProvider {
  return {
    name: "commons",
    async search(query: string, intent: ImageIntent, signal: AbortSignal) {
      const search = intent === "map" ? `${query} map` : `${query} filetype:bitmap`;
      const { pages } = await wiki(HOSTS.commons, {
        generator: "search", gsrsearch: search, gsrnamespace: "6", gsrlimit: "12",
        prop: "imageinfo", iiprop: "url|size|mime|thumbmime", iiurlwidth: String(THUMB_WIDTH),
      }, signal, request);
      return pages.flatMap(page => {
        const info = page.imageinfo?.[0];
        if (!info) return [];
        const url = info.thumburl ?? info.url;
        return [{
          provider: "commons", url, title: fileTitle(page.title),
          width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height,
          mime: info.thumbmime ?? mimeFromURL(url) ?? info.mime,
          relevance: overlap(query, fileTitle(page.title)) * (1 - Math.min(10, (page.index ?? 12) - 1) * 0.03),
          pageUrl: info.descriptionurl, license: "free (Wikimedia Commons)",
        } satisfies ImageCandidate];
      });
    },
  };
}

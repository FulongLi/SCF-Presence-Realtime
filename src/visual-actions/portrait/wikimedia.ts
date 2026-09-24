import { allowedImageURL } from "../validate";

/**
 * Client-side portrait lookup through Wikimedia's public, anonymous CORS API (`origin=*`).
 * Only the person's name is sent. No credentials, cookies or server of our own are involved,
 * and no conversation text: a portrait tool call contributes exactly one name.
 */
export interface PortraitResult { name: string; image: Blob; source: string; author: string; license: string }

type WikiPage = { title: string; index?: number; pageimage?: string; pageprops?: { disambiguation?: string };
  imageinfo?: { thumburl?: string; url: string; extmetadata?: Record<string, { value: string }> }[] };
type WikiData = { query?: { pages?: WikiPage[] }; error?: unknown };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function boundedBytes(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error("portrait-unavailable");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error("portrait-too-large"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/** Downloads an allowlisted Wikimedia image with a size bound and a strict content type. */
export async function fetchPortraitImage(value: string, signal: AbortSignal, request: typeof fetch = fetch) {
  const url = allowedImageURL(value);
  const response = await request(url, { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
  const mime = response.headers.get("content-type")?.split(";")[0].trim();
  if (!mime || !IMAGE_TYPES.includes(mime)) throw new Error("portrait-type");
  const bytes = await boundedBytes(response, 6 * 1024 * 1024);
  return new Blob([bytes], { type: mime });
}

export async function findPortrait(name: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<PortraitResult> {
  const language = /[㐀-鿿]/u.test(name) ? "zh" : "en";
  async function wiki(host: string, params: Record<string, string>): Promise<WikiData> {
    const url = new URL(`https://${host}/w/api.php`);
    url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", ...params }).toString();
    const response = await request(url, { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    const data = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1024 * 1024))) as WikiData;
    if (data.error) throw new Error("portrait-unavailable");
    return data;
  }
  const lookup = { prop: "pageimages|pageprops", piprop: "name", pilicense: "free" };
  let result = await wiki(`${language}.wikipedia.org`, { titles: name, redirects: "1", ...lookup });
  let page = result.query?.pages?.find(p => p.pageimage && p.pageprops?.disambiguation === undefined);
  if (!page) {
    result = await wiki(`${language}.wikipedia.org`, { generator: "search", gsrsearch: name, gsrnamespace: "0", gsrlimit: "5", ...lookup });
    page = result.query?.pages?.sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .find(p => p.pageimage && p.pageprops?.disambiguation === undefined);
  }
  if (!page?.pageimage) throw new Error("portrait-not-found");
  const info = await wiki("commons.wikimedia.org", { titles: `File:${page.pageimage}`, prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "640" });
  const image = info.query?.pages?.[0]?.imageinfo?.[0];
  if (!image) throw new Error("portrait-not-found");
  const blob = await fetchPortraitImage(image.thumburl ?? image.url, signal, request);
  const plain = (value?: string) => (value ?? "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").slice(0, 500);
  return {
    name: page.title, image: blob,
    source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(`File:${page.pageimage}`)}`,
    author: plain(image.extmetadata?.Artist?.value), license: plain(image.extmetadata?.LicenseShortName?.value),
  };
}

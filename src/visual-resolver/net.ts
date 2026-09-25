import { ResolveError } from "./types";

/**
 * The resolver's only way onto the network. Every request is anonymous (no cookies or credentials),
 * HTTPS-only to an allowlisted host, refuses redirects, has a timeout, checks the content type and
 * stops reading at a byte limit. The browser never holds a provider secret; keyed providers go
 * through SCF's own server route (same origin).
 */
export type Fetcher = typeof fetch;

export const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export const limits = {
  /** Largest image the resolver will download. */
  imageBytes: 6 * 1024 * 1024,
  /** Largest JSON document (search results, geocoder polygons). */
  jsonBytes: 3 * 1024 * 1024,
  /** Per-request timeout. */
  requestMs: 8000,
  /** Longest URL the resolver will request. */
  urlLength: 2048,
};

/** Exact hosts, or a pattern for families such as language Wikipedias. */
export type HostRule = string | RegExp;
export const HOSTS = {
  wikipedia: /^[a-z][a-z-]{1,11}\.wikipedia\.org$/,
  commons: "commons.wikimedia.org",
  wikimediaImages: ["upload.wikimedia.org", "thumb.wikimedia.org"],
  openverse: "api.openverse.org",
  nominatim: "nominatim.openstreetmap.org",
  photon: "photon.komoot.io",
  elevation: "s3.amazonaws.com",
} as const;

function hostAllowed(host: string, rules: readonly HostRule[]) {
  return rules.some(rule => typeof rule === "string" ? rule === host : rule.test(host));
}

/** Parses and checks a URL against a host allowlist: https, no credentials, no port. */
export function checkedURL(value: string | URL, rules: readonly HostRule[], base?: string): URL {
  const text = String(value);
  if (text.length > limits.urlLength) throw new ResolveError("url-rejected");
  let url: URL;
  try { url = new URL(text, base); } catch { throw new ResolveError("url-rejected"); }
  const sameOrigin = base !== undefined && url.origin === new URL(base).origin;
  if (!sameOrigin && (url.protocol !== "https:" || url.port || !hostAllowed(url.hostname, rules))) throw new ResolveError("url-rejected");
  if (url.username || url.password) throw new ResolveError("url-rejected");
  return url;
}

/** Reads a body up to `limit` bytes, cancelling the stream as soon as it is exceeded. */
export async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => {}); throw new ResolveError("too-large"); }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel().catch(() => {}); throw new ResolveError("too-large"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/**
 * A timeout signal backed by an ordinary (ref'd) timer that the caller clears when done.
 * `AbortSignal.timeout()` uses an unref'd timer in Node: when a hung request is the only pending work,
 * the event loop can drain before it fires, so the timeout never happens (and Node's test runner
 * cancels the test). This keeps the behaviour deterministic in every runtime.
 */
export function timeoutSignal(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export interface FetchOptions {
  hosts: readonly HostRule[];
  mimes: readonly string[];
  maxBytes: number;
  signal: AbortSignal;
  request?: Fetcher;
  timeoutMs?: number;
  /** Same-origin base for SCF's own routes (browser only). */
  base?: string;
  init?: RequestInit;
  referrer?: ReferrerPolicy;
}

export interface Fetched { bytes: Uint8Array; mime: string; url: string; ms: number }

/** One guarded request. Errors are ResolveErrors with short codes (timeout, http-404, type, too-large…). */
export async function safeFetch(value: string | URL, options: FetchOptions): Promise<Fetched> {
  const started = Date.now();
  const url = checkedURL(value, options.hosts, options.base);
  const timeout = timeoutSignal(options.timeoutMs ?? limits.requestMs);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  try {
    let response: Response;
    try {
      response = await (options.request ?? fetch)(url, {
        ...options.init, signal, redirect: "error", credentials: "omit",
        referrerPolicy: options.referrer ?? "no-referrer",
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (timeout.signal.aborted) throw new ResolveError("timeout");
      throw error instanceof ResolveError ? error : new ResolveError("network");
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ResolveError(`http-${response.status}`); }
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!options.mimes.includes(mime)) { await response.body?.cancel().catch(() => {}); throw new ResolveError("type"); }
    let bytes: Uint8Array;
    try { bytes = await boundedBytes(response, options.maxBytes); } catch (error) {
      options.signal.throwIfAborted();
      if (timeout.signal.aborted) throw new ResolveError("timeout");
      throw error;
    }
    return { bytes, mime, url: url.href, ms: Date.now() - started };
  } finally { timeout.clear(); }
}

/** A guarded JSON request; also returns how long it took. */
export async function fetchJSON<T>(value: string | URL, options: Omit<FetchOptions, "mimes" | "maxBytes"> & { maxBytes?: number }): Promise<{ data: T; ms: number }> {
  const fetched = await safeFetch(value, { ...options, mimes: ["application/json"], maxBytes: options.maxBytes ?? limits.jsonBytes });
  try {
    return { data: JSON.parse(new TextDecoder().decode(fetched.bytes)) as T, ms: fetched.ms };
  } catch { throw new ResolveError("bad-json"); }
}

/** The real format from the file's first bytes (JPEG, PNG or WebP), whatever the server claims. */
export function sniffImage(bytes: Uint8Array): (typeof IMAGE_MIME)[number] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** A guarded image request: JPEG, PNG or WebP only (by header and by content), at most `limits.imageBytes`. */
export async function fetchImage(value: string | URL, options: Omit<FetchOptions, "mimes" | "maxBytes"> & { maxBytes?: number }) {
  const fetched = await safeFetch(value, { ...options, mimes: IMAGE_MIME, maxBytes: options.maxBytes ?? limits.imageBytes });
  const mime = sniffImage(fetched.bytes);
  if (!mime) throw new ResolveError("type");
  return { blob: new Blob([fetched.bytes as BlobPart], { type: mime }), ms: fetched.ms, url: fetched.url };
}

/** Lower-case word tokens (letters and digits of any script), for relevance scoring. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 1 || /\d/.test(t));
}

/** Fraction of the query's tokens found in `text` (0..1). */
export function overlap(query: string, text: string): number {
  const wanted = tokens(query);
  if (!wanted.length) return 0;
  const have = new Set(tokens(text));
  return wanted.filter(token => have.has(token)).length / wanted.length;
}

import { visualForms } from "../visual-forms";
import { IMAGE_INTENTS, SYMBOL_NAMES, TERRAIN_STYLES, type ImageIntent, type SymbolName, type TerrainStyle, type VisualAction } from "./types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const graphemes = (value: string) => Array.from(value).length;
/** Control, zero-width and bidirectional-override characters: never part of a name, query or label. */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;

export const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const NUMBER = /^[+\-−]?\p{Sc}?\d[\d.,:/ ]*(?:%|°[CF]?|\p{Sc})?$/u;
const TEXT = /^[\p{L}\p{M}\p{N} .,!?'’\-&·:()]+$/u;
const PERSON = /^[\p{L}\p{M} .'’·\-]+$/u;
/** Free-text visual queries: words, numbers and ordinary punctuation. No markup, URLs or code. */
const QUERY = /^[\p{L}\p{M}\p{N} .,'’·\-&()/:+#!?"]+$/u;
const LINKISH = /(?:\/\/|www\.|\b(?:javascript|data|file|https?):(?!\s))/i;

/**
 * Emoji are validated as whole sequences, never by `.length`: one emoji can be many code points.
 * The pattern is an allowlist of the RGI constructions, so ordinary text, markup, URLs and control
 * characters cannot match:
 * - an emoji character (Extended_Pictographic that is also Emoji, so digits, letters and unassigned
 *   pictographic code points are excluded), optionally with a skin-tone modifier and/or VS-16;
 * - up to four of those joined by ZWJ (👨‍🚀, 👨‍👩‍👧‍👦, 👩‍❤️‍💋‍👨);
 * - a regional-indicator pair (🇬🇧), a keycap (1️⃣, #️⃣) or a tag sequence (🏴󠁧󠁢󠁷󠁬󠁳󠁿).
 */
const EMOJI_ELEMENT = String.raw`(?:(?=\p{Emoji})\p{Extended_Pictographic}(?:\p{Emoji_Modifier}️?|️)?)`;
const EMOJI = new RegExp(String.raw`^(?:${EMOJI_ELEMENT}(?:‍${EMOJI_ELEMENT}){0,3}`
  + String.raw`|\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\u{1F3F4}[\u{E0020}-\u{E007E}]{1,8}\u{E007F})$`, "u");
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * Exactly one emoji: a single grapheme cluster (Unicode segmentation, `Intl.Segmenter`) that is an
 * emoji sequence. Rejects empty strings, text, markup, URLs, control characters and several emoji
 * ("😊😂"). Where `Intl.Segmenter` is missing, the anchored pattern alone still admits only one sequence.
 */
export function isSingleEmojiGrapheme(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 || !EMOJI.test(value)) return false;
  if (!graphemeSegmenter) return true;
  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  return !segments.next().done && Boolean(segments.next().done);
}

/** Open text for image queries and terrain regions: generous, but never markup, a URL or control text. */
export function validQuery(value: unknown, max: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && Array.from(value).length <= max
    && QUERY.test(value) && !LINKISH.test(value) && !CONTROL.test(value) && /[\p{L}\p{N}]/u.test(value);
}

export function validPerson(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 60
    && PERSON.test(value) && !CONTROL.test(value);
}

/** Portrait image URLs may only point at Wikimedia's image hosts, over HTTPS, without credentials or ports. */
export function allowedImageURL(value: string) {
  if (value.length > 600) throw new Error("image-url-rejected");
  const url = new URL(value);
  if (url.protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) || url.port || url.username || url.password
    || !/\.(?:jpe?g|png|webp)$/i.test(url.pathname)) throw new Error("image-url-rejected");
  return url;
}

/**
 * Strict allowlist validation. Unknown types, unknown fields, markup, scripts and arbitrary URLs are rejected.
 * Returns a normalized copy; the input object is never reused.
 */
export function validateVisualAction(value: unknown): VisualAction | null {
  if (!record(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "sphere":
      return onlyKeys(value, ["type"]) ? { type: "sphere" } : null;
    case "clock": {
      if (!onlyKeys(value, ["type", "time", "timestamp"])) return null;
      const action: VisualAction = { type: "clock" };
      if (value.time !== undefined) {
        if (typeof value.time !== "string" || !CLOCK_TIME.test(value.time)) return null;
        action.time = value.time;
      }
      if (value.timestamp !== undefined) {
        if (typeof value.timestamp !== "number" || !Number.isInteger(value.timestamp)
          || value.timestamp < 0 || value.timestamp > 8.64e15) return null;
        action.timestamp = value.timestamp;
      }
      return action;
    }
    case "number": {
      if (!onlyKeys(value, ["type", "value"]) || typeof value.value !== "string") return null;
      const text = value.value.trim();
      return text && text.length <= 12 && NUMBER.test(text) ? { type: "number", value: text } : null;
    }
    case "text": {
      if (!onlyKeys(value, ["type", "value"]) || typeof value.value !== "string") return null;
      const text = value.value.trim().replace(/\s+/g, " ");
      if (!text || graphemes(text) > 16 || CONTROL.test(text) || !TEXT.test(text)) return null;
      return { type: "text", value: text };
    }
    case "symbol":
      return onlyKeys(value, ["type", "value"]) && SYMBOL_NAMES.includes(value.value as SymbolName)
        ? { type: "symbol", value: value.value as SymbolName } : null;
    case "emoji":
      return onlyKeys(value, ["type", "value"]) && isSingleEmojiGrapheme(value.value) ? { type: "emoji", value: value.value } : null;
    case "form": {
      // Only registered form ids, and only variants that form declares: an allowlist, like symbols.
      if (!onlyKeys(value, ["type", "form", "variant"]) || typeof value.form !== "string") return null;
      const entry = visualForms.get(value.form);
      if (!entry) return null;
      if (value.variant === undefined) return { type: "form", form: entry.id };
      return entry.variants?.some(variant => variant.id === value.variant) ? { type: "form", form: entry.id, variant: value.variant as string } : null;
    }
    case "portrait": {
      if (!onlyKeys(value, ["type", "person", "imageUrl"])) return null;
      const action: VisualAction = { type: "portrait" };
      if (value.person !== undefined) {
        if (!validPerson(value.person)) return null;
        action.person = value.person;
      }
      if (value.imageUrl !== undefined) {
        if (typeof value.imageUrl !== "string") return null;
        try { action.imageUrl = allowedImageURL(value.imageUrl).href; } catch { return null; }
      }
      return action.person || action.imageUrl ? action : null;
    }
    case "image": {
      if (!onlyKeys(value, ["type", "query", "intent"])) return null;
      const query = typeof value.query === "string" ? value.query.trim().replace(/\s+/g, " ") : value.query;
      if (!validQuery(query, 100)) return null;
      if (value.intent !== undefined && !IMAGE_INTENTS.includes(value.intent as ImageIntent)) return null;
      return value.intent === undefined ? { type: "image", query } : { type: "image", query, intent: value.intent as ImageIntent };
    }
    case "terrain": {
      if (!onlyKeys(value, ["type", "region", "style"])) return null;
      const region = typeof value.region === "string" ? value.region.trim().replace(/\s+/g, " ") : value.region;
      if (!validQuery(region, 80)) return null;
      if (value.style !== undefined && !TERRAIN_STYLES.includes(value.style as TerrainStyle)) return null;
      return value.style === undefined ? { type: "terrain", region } : { type: "terrain", region, style: value.style as TerrainStyle };
    }
    default:
      return null;
  }
}

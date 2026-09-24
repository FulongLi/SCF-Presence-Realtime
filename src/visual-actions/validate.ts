import { SYMBOL_NAMES, type SymbolName, type VisualAction } from "./types";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const graphemes = (value: string) => Array.from(value).length;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;

export const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const NUMBER = /^[+\-−]?\p{Sc}?\d[\d.,:/ ]*(?:%|°[CF]?|\p{Sc})?$/u;
const TEXT = /^[\p{L}\p{M}\p{N} .,!?'’\-&·:()]+$/u;
const PERSON = /^[\p{L}\p{M} .'’·\-]+$/u;

export function validPerson(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 60
    && PERSON.test(value) && !CONTROL.test(value);
}

/** Portrait images may only come from Wikimedia's upload host, over HTTPS, without credentials or ports. */
export function allowedImageURL(value: string) {
  if (value.length > 600) throw new Error("image-url-rejected");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "upload.wikimedia.org" || url.port || url.username || url.password
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
    default:
      return null;
  }
}

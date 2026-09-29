/**
 * Concise function results returned to the model (the Realtime model, or GPT-Live's Responses backend). They describe what the body did in a few
 * fields so the model can continue naturally; they never contain internal protocol details.
 */
export type ToolStatus =
  | "displayed" | "forming" | "returning" | "body-changed" | "unchanged"
  | "invalid-arguments" | "unknown-tool" | "superseded"
  | "portrait-not-found" | "portrait-unavailable"
  | "image-not-found" | "image-unavailable"
  | "region-not-found" | "terrain-unavailable"
  | "form-not-found" | "form-unavailable"
  | "unresolved";

export interface ToolResult {
  ok: boolean;
  status: ToolStatus;
  /** What the body shows, when the model may want to say it (e.g. the local time, which form a name found, or the persistent body). */
  shown?: string;
  /** For clocks: the user's IANA time zone, so a spoken time can be qualified if needed. */
  timeZone?: string;
}

export const displayed = (extra: Omit<ToolResult, "ok" | "status"> = {}): ToolResult => ({ ok: true, status: "displayed", ...extra });
export const failed = (status: Exclude<ToolStatus, "displayed" | "forming" | "returning" | "body-changed" | "unchanged">): ToolResult => ({ ok: false, status });

const FAILURES = new Set<string>([
  "portrait-not-found", "portrait-unavailable", "image-not-found", "image-unavailable",
  "region-not-found", "terrain-unavailable", "form-not-found", "form-unavailable", "superseded", "invalid-arguments", "unknown-tool",
]);

/** Maps a controller failure code (from the Visual Resolver) to a stable, model-facing status. */
export function failureStatus(code: string | null | undefined): ToolResult {
  if (code && FAILURES.has(code)) return failed(code as Parameters<typeof failed>[0]);
  if (code?.startsWith("portrait-")) return failed("portrait-unavailable");
  if (code?.startsWith("image-")) return failed("image-unavailable");
  if (code?.startsWith("terrain-") || code?.startsWith("heightfield-") || code?.startsWith("region-")) return failed("terrain-unavailable");
  if (code?.startsWith("form-")) return failed("form-unavailable");
  return failed("unresolved");
}

/** The function_call_output payload is a JSON string. */
export const serializeResult = (result: ToolResult) => JSON.stringify(result);

/**
 * Concise function results returned to the Realtime model. They describe what the body did in a few
 * fields so the model can continue naturally; they never contain internal protocol details.
 */
export type ToolStatus =
  | "displayed" | "forming" | "returning"
  | "invalid-arguments" | "unknown-tool" | "superseded"
  | "portrait-not-found" | "portrait-unavailable" | "unresolved";

export interface ToolResult {
  ok: boolean;
  status: ToolStatus;
  /** What the body shows, when the model may want to say it (e.g. the local time). */
  shown?: string;
  /** For clocks: the user's IANA time zone, so a spoken time can be qualified if needed. */
  timeZone?: string;
}

export const displayed = (extra: Omit<ToolResult, "ok" | "status"> = {}): ToolResult => ({ ok: true, status: "displayed", ...extra });
export const failed = (status: Exclude<ToolStatus, "displayed" | "forming" | "returning">): ToolResult => ({ ok: false, status });

const FAILURES = new Set<string>(["portrait-not-found", "portrait-unavailable", "superseded", "invalid-arguments", "unknown-tool"]);

/** Maps a controller failure code (e.g. from Wikimedia lookup) to a stable, model-facing status. */
export function failureStatus(code: string | null | undefined): ToolResult {
  if (code && FAILURES.has(code)) return failed(code as Parameters<typeof failed>[0]);
  if (code?.startsWith("portrait-") || code?.startsWith("image-")) return failed("portrait-unavailable");
  return failed("unresolved");
}

/** The function_call_output payload is a JSON string. */
export const serializeResult = (result: ToolResult) => JSON.stringify(result);

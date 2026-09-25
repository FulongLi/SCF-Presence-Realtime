import type { SubmitOutcome } from "../../visual-actions/controller";
import { clockText } from "../../visual-resolver/providers/glyphs";
import { IMAGE_INTENTS, TERRAIN_STYLES, type VisualAction } from "../../visual-actions/types";
import { validateVisualAction } from "../../visual-actions/validate";
import { isVisualToolName, type VisualToolName } from "./definitions";
import { displayed, failed, failureStatus, type ToolResult } from "./results";

/** The part of VisualActionController the executor drives. */
export interface VisualBody {
  submit(action: VisualAction): Promise<SubmitOutcome>;
  readonly lastFailure: string | null;
}

export interface ToolExecution {
  name: string;
  /** The validated action, or null when the call was rejected before reaching the body. */
  action: VisualAction | null;
  result: ToolResult;
  ms: number;
}

/** Anything that executes a visual tool call: the ToolExecutor, or a wrapper around it. */
export interface ToolRunner { execute(name: string, rawArguments: string): Promise<ToolExecution> }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const pad = (value: number) => String(value).padStart(2, "0");
/**
 * Optional enum hints (image intent, terrain style) are advisory: an unknown word falls back to the
 * default instead of failing the whole call. A non-string is still invalid.
 */
function hint(value: unknown, allowed: readonly string[]): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  return allowed.includes(word) ? word : undefined;
}

/**
 * Models sometimes say "3:42 PM" or "7:05" where the schema asks for 24-hour HH:MM.
 * Unambiguous forms are normalized; anything else is rejected rather than guessed.
 */
export function normalizeClockTime(value: string): string | null {
  const match = /^\s*(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

/**
 * Maps a native tool call onto the one Visual Action schema shared by every path to the body.
 * The result still goes through validateVisualAction(); this only renames fields.
 */
export function toolCallToVisualAction(name: VisualToolName, args: Record<string, unknown>): VisualAction | null {
  const text = (key: string) => typeof args[key] === "string" ? (args[key] as string).trim() : undefined;
  let candidate: unknown;
  switch (name) {
    case "show_clock": {
      if (!onlyKeys(args, ["time"])) return null;
      if (args.time === undefined || args.time === null || text("time") === "") { candidate = { type: "clock" }; break; }
      const time = typeof args.time === "string" ? normalizeClockTime(args.time) : null;
      if (!time) return null;
      candidate = { type: "clock", time };
      break;
    }
    case "show_image": {
      if (!onlyKeys(args, ["query", "intent"])) return null;
      const intent = hint(args.intent, IMAGE_INTENTS);
      candidate = { type: "image", query: text("query")?.replace(/\s+/g, " ") ?? args.query, ...(intent === undefined ? {} : { intent }) };
      break;
    }
    case "show_terrain": {
      if (!onlyKeys(args, ["region", "style"])) return null;
      const style = hint(args.style, TERRAIN_STYLES);
      candidate = { type: "terrain", region: text("region")?.replace(/\s+/g, " ") ?? args.region, ...(style === undefined ? {} : { style }) };
      break;
    }
    case "show_portrait":
      if (!onlyKeys(args, ["person"])) return null;
      candidate = { type: "portrait", person: text("person")?.replace(/\s+/g, " ") };
      break;
    case "show_number":
      if (!onlyKeys(args, ["value"])) return null;
      candidate = { type: "number", value: args.value };
      break;
    case "show_text":
      if (!onlyKeys(args, ["value"])) return null;
      candidate = { type: "text", value: args.value };
      break;
    case "show_symbol":
      if (!onlyKeys(args, ["symbol"])) return null;
      candidate = { type: "symbol", value: text("symbol")?.toLowerCase() };
      break;
    case "show_emoji":
      if (!onlyKeys(args, ["emoji"])) return null;
      candidate = { type: "emoji", value: text("emoji") ?? args.emoji };
      break;
    case "return_to_sphere":
      if (!onlyKeys(args, [])) return null;
      candidate = { type: "sphere" };
      break;
  }
  return validateVisualAction(candidate);
}

/** Parses the arguments string of a function call. Empty arguments mean "{}". */
export function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return record(value) ? value : null;
  } catch { return null; }
}

export const executorDefaults = {
  /** How long a call may wait for its target (e.g. a portrait download) before reporting "forming". */
  budgetMs: 1500,
};

/**
 * Executes native visual tool calls locally. Voice never waits on this: the model keeps speaking while
 * the body forms; the result only tells the model what happened.
 */
export class ToolExecutor {
  constructor(
    private readonly visual: VisualBody,
    private readonly options = {
      ...executorDefaults,
      now: () => new Date(),
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  ) {}

  async execute(name: string, rawArguments: string): Promise<ToolExecution> {
    const started = Date.now();
    const done = (action: VisualAction | null, result: ToolResult): ToolExecution =>
      ({ name, action, result, ms: Date.now() - started });
    if (!isVisualToolName(name)) return done(null, failed("unknown-tool"));
    const args = parseToolArguments(rawArguments);
    const action = args ? toolCallToVisualAction(name, args) : null;
    if (!action) return done(null, failed("invalid-arguments"));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), this.options.budgetMs); });
    let outcome: SubmitOutcome | "late";
    try {
      outcome = await Promise.race([this.visual.submit(action), late]);
    } catch {
      outcome = "failed";
    } finally { clearTimeout(timer); }

    switch (outcome) {
      case "sphere":
        return done(action, { ok: true, status: "returning" });
      case "late":
        return done(action, { ok: true, status: "forming" });
      case "cancelled":
        return done(action, failed("superseded"));
      case "failed":
        return done(action, failureStatus(this.visual.lastFailure));
      case "queued":
        if (action.type === "clock") {
          return done(action, displayed({ shown: clockText(action, this.options.now()), timeZone: this.options.timeZone() }));
        }
        return done(action, displayed());
    }
  }
}

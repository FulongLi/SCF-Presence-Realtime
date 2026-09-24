/**
 * Visual Actions are temporary, informational expressions of the sphere.
 * The sphere is the identity; every action returns to it.
 */
export type VisualAction =
  | { type: "sphere" }
  | { type: "clock"; time?: string; timestamp?: number }
  | { type: "number"; value: string }
  | { type: "text"; value: string }
  | { type: "symbol"; value: SymbolName }
  | { type: "portrait"; person?: string; imageUrl?: string };

export type VisualActionType = VisualAction["type"];

export const SYMBOL_NAMES = [
  "check", "cross", "heart", "star", "question", "exclamation",
  "arrow-up", "arrow-down", "arrow-left", "arrow-right", "plus", "minus",
] as const;
export type SymbolName = typeof SYMBOL_NAMES[number];

/** How long each information state is held before the body returns to the sphere (seconds). */
export const HOLD_SECONDS: Record<Exclude<VisualActionType, "sphere">, number> = {
  clock: 7, number: 7, text: 6, symbol: 5, portrait: 14,
};

/** A particle arrangement ready for the runtime: a raster sampled into rest positions. */
export interface Raster { width: number; height: number; data: Uint8ClampedArray }
export interface MorphTarget {
  raster: Raster;
  /** "portrait" keeps photographic tone and relief; "glyph" samples crisp shapes with even light. */
  style: "portrait" | "glyph";
  /** Seconds to hold the formed state. */
  hold: number;
  label: string;
}

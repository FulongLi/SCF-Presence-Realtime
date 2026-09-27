import type { VisualTarget } from "../visual-resolver/types";

/**
 * Visual Actions are temporary, informational expressions of the sphere.
 * The sphere is the identity; every action returns to it.
 *
 * `image` and `terrain` are open: the query or region is free text that the Visual Resolver turns into
 * a target. `emoji` is any single Unicode emoji, drawn locally from the system emoji font. `form` is a
 * concept from SCF's own visual language (a registered visual form, e.g. "tao.yin-yang" or
 * "astronomy.orion"), drawn procedurally. The other types are convenience shapes with a fixed vocabulary.
 */
export type VisualAction =
  | { type: "sphere" }
  | { type: "clock"; time?: string; timestamp?: number }
  | { type: "number"; value: string }
  | { type: "text"; value: string }
  | { type: "symbol"; value: SymbolName }
  | { type: "emoji"; value: string }
  /** `form` is always a registered form id (see visual-forms); names and aliases are resolved before validation. */
  | { type: "form"; form: string; variant?: string }
  | { type: "portrait"; person?: string; imageUrl?: string }
  | { type: "image"; query: string; intent?: ImageIntent }
  | { type: "terrain"; region: string; style?: TerrainStyle };

export type VisualActionType = VisualAction["type"];

export const SYMBOL_NAMES = [
  "check", "cross", "heart", "star", "question", "exclamation",
  "arrow-up", "arrow-down", "arrow-left", "arrow-right", "plus", "minus",
] as const;
export type SymbolName = typeof SYMBOL_NAMES[number];

/** What kind of picture an image query is after. It steers provider order, ranking and cropping. */
export const IMAGE_INTENTS = ["portrait", "celebrity", "object", "vehicle", "product", "reference", "map", "general"] as const;
export type ImageIntent = typeof IMAGE_INTENTS[number];

/** How a height field is lit and toned. The geometry is the same real elevation for every style. */
export const TERRAIN_STYLES = ["terrain", "topography", "relief", "heightmap"] as const;
export type TerrainStyle = typeof TERRAIN_STYLES[number];

/**
 * How long each information state is held before the body returns to the sphere (seconds). An emoji
 * is a brief expression, like a gesture, so it holds for less time than information does.
 */
export const HOLD_SECONDS: Record<Exclude<VisualActionType, "sphere">, number> = {
  clock: 7, number: 7, text: 6, symbol: 5, emoji: 4, form: 10, portrait: 14, image: 12, terrain: 14,
};

/** A particle arrangement ready for the runtime: any visual target plus how long to hold it. */
export interface MorphTarget {
  visual: VisualTarget;
  /** Seconds to hold the formed state. */
  hold: number;
  label: string;
  /**
   * Optional morph durations in seconds for this target (default `transitionSeconds`). The product never
   * sets them; a director may, e.g. to let a brand mark form more deliberately than a clock.
   */
  transition?: { form?: number; return?: number };
  /**
   * Optional movement of the formed visual. `spin`: radians per second it turns about the view axis while
   * formed (anticlockwise positive; default 0), e.g. a slowly turning yin-yang. Starts upright each time.
   */
  motion?: { spin?: number };
}

export type { Raster } from "../visual-resolver/types";

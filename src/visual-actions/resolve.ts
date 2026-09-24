import type { InformationAction } from "./controller";
import { findPortrait, fetchPortraitImage } from "./portrait/wikimedia";
import { createTargetPoints } from "./targets/points";
import { decodeImage, rasterizeSymbol, rasterizeText } from "./targets/rasterize";
import { HOLD_SECONDS, type MorphTarget, type VisualAction } from "./types";

const pad = (value: number) => String(value).padStart(2, "0");

/** The time a clock action should show: explicit time, else timestamp in local time, else now. */
export function clockText(action: Extract<VisualAction, { type: "clock" }>, now = new Date()) {
  if (action.time) return action.time;
  const date = action.timestamp !== undefined ? new Date(action.timestamp) : now;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Browser resolver: turns a validated action into a particle target. */
export async function resolveVisualTarget(action: InformationAction, signal: AbortSignal): Promise<MorphTarget> {
  const hold = HOLD_SECONDS[action.type];
  switch (action.type) {
    case "clock": { const label = clockText(action); return { raster: rasterizeText(label), style: "glyph", hold, label }; }
    case "number":
    case "text": return { raster: rasterizeText(action.value), style: "glyph", hold, label: action.value };
    case "symbol": return { raster: rasterizeSymbol(action.value), style: "glyph", hold, label: action.value };
    case "portrait": {
      const found = action.imageUrl
        ? { image: await fetchPortraitImage(action.imageUrl, signal), name: action.person ?? "" }
        : await findPortrait(action.person!, signal);
      signal.throwIfAborted();
      const target: MorphTarget = { raster: await decodeImage(found.image), style: "portrait", hold, label: found.name };
      createTargetPoints(target, 1); // Reject unusable images before they reach the render loop.
      return target;
    }
  }
}

/** A local photo becomes a portrait action without any network request. */
export async function localPortrait(file: Blob, label: string): Promise<MorphTarget> {
  const target: MorphTarget = { raster: await decodeImage(file), style: "portrait", hold: HOLD_SECONDS.portrait, label };
  createTargetPoints(target, 1);
  return target;
}

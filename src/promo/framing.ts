import type { MorphTarget, Raster } from "../visual-actions/types";
import type { VisualId } from "./script";

/**
 * Film framing: presentation-only treatment of a resolved target, the particle equivalent of a
 * cinematographer's vignette. The product's resolver, crop and sampler are untouched; only a portrait
 * photograph's rectangular edge is feathered into black (through its alpha, which the product's portrait
 * sampler already weights density by), so the face emerges from the body instead of sitting in a box.
 */
export const FRAMING = {
  portrait: {
    /** Superellipse exponent of the feather (2 = ellipse, higher = squarer). */
    shape: 2.4,
    /** Normalized radius where the feather begins and where the picture has fully dissolved. */
    inner: 0.62, outer: 1.02,
    /** The oval sits slightly high: faces are in the upper part of a head-and-shoulders crop. */
    center: -0.06,
  },
};

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A copy of `raster` whose alpha dissolves toward a soft oval edge. */
export function featherRaster(raster: Raster, f = FRAMING.portrait): Raster {
  const { width, height } = raster;
  const data = new Uint8ClampedArray(raster.data);
  for (let y = 0; y < height; y++) {
    const ny = Math.abs(((y + 0.5) / height - 0.5) * 2 - f.center);
    for (let x = 0; x < width; x++) {
      const nx = Math.abs(((x + 0.5) / width - 0.5) * 2);
      const r = Math.pow(Math.pow(nx, f.shape) + Math.pow(ny, f.shape), 1 / f.shape);
      const i = (y * width + x) * 4 + 3;
      data[i] = Math.round(data[i] * (1 - smooth(f.inner, f.outer, r)));
    }
  }
  return { width, height, data };
}

/** The target as the film shows it. Everything but a portrait photograph passes through unchanged. */
export function frameTarget(id: VisualId, target: MorphTarget): MorphTarget {
  if (id === "tesla" && target.visual.kind === "raster2d" && target.visual.style === "portrait") {
    return { ...target, visual: { ...target.visual, raster: featherRaster(target.visual.raster) } };
  }
  return target;
}

/**
 * The film's only transition vocabulary besides particle transformation itself: opacity, slow easing and
 * short pauses. No wipes, zooms, flashes or glitches.
 */

export const clamp01 = (x: number) => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
/** Smooth start and end (C2), for opacity and camera moves. */
export const smootherstep = (x: number) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };
/** Gentle ease-out for fades in; opacity arrives softly. */
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 2.2);
/** Gentle ease-in for fades out. */
export const easeIn = (x: number) => Math.pow(clamp01(x), 1.8);

/** A fade-in → hold → fade-out span on the master timeline (seconds). */
export interface FadeSpan { start: number; fadeIn: number; hold: number; fadeOut: number }
export const spanEnd = (span: FadeSpan) => span.start + span.fadeIn + span.hold + span.fadeOut;

/** Opacity of a fade span at time t. A hold of Infinity never fades out. */
export function spanOpacity(span: FadeSpan, t: number): number {
  if (t <= span.start) return 0;
  const inEnd = span.start + span.fadeIn;
  if (t < inEnd) return easeOut((t - span.start) / span.fadeIn);
  const outStart = inEnd + span.hold;
  if (t < outStart) return 1;
  return 1 - easeIn((t - outStart) / span.fadeOut);
}

import type { MorphTarget } from "../visual-actions/types";
import type { VisualTarget } from "../visual-resolver/types";

/**
 * Visual forms: SCF's own visual language. Where show_image retrieves a picture from outside, a visual
 * form is a concept the body already knows how to draw (a yin-yang, a trigram, a constellation, a zodiac
 * glyph), built procedurally on the device into an ordinary VisualTarget. Forms come in packs; the
 * registry (registry.ts) is the one extension point: a new pack is data plus a renderer, never new tools,
 * new action types or code in the particle runtime.
 */

/** A named variation of a form, e.g. the Later Heaven arrangement of the bagua. The first listed is the default. */
export interface FormVariant {
  id: string;
  label: string;
  /** Names that select this form *and* this variant, e.g. "后天八卦". */
  aliases?: readonly string[];
}

/** How a form appears on the body: the target, plus how it moves while formed. */
export interface FormRendering {
  visual: VisualTarget;
  /** Radians per second the formed visual turns about the view axis (anticlockwise positive). Default 0. */
  spin?: number;
}

export interface VisualFormEntry {
  /** `<category>.<name>`, lower-case words joined by dashes, e.g. "tao.yin-yang", "astronomy.ursa-major". */
  id: string;
  category: string;
  /** The procedural renderer that draws it, e.g. "ink", "star-map", "star-glyph" (for traces and docs). */
  renderer: string;
  /** Short human label, also reported to the model, e.g. "Qian ☰ (乾, Heaven)". */
  label: string;
  /** Names people and models use, in any language or script; matched after normalizeFormName(). */
  aliases: readonly string[];
  /**
   * Ordinary words that name this form only together with a category hint: "ram" finds Aries in "sign of
   * the ram" and "fire" finds Li in "fire trigram", but "fish" alone never draws Pisces.
   */
  terms?: readonly string[];
  variants?: readonly FormVariant[];
  /** Pure and deterministic: the same form and variant always give the same target. */
  render(variant: string | undefined): FormRendering;
}

export interface FormCategory {
  /** e.g. "tao", "astronomy", "astrology"; also the id prefix of its forms. */
  id: string;
  /** The family it belongs to in the hierarchy, e.g. astronomy and astrology are both "celestial". */
  family: string;
  label: string;
  /**
   * Words that point a free-form name at this category ("constellation", "zodiac", "trigram"). They are
   * removed before matching, and only this category's forms are considered, so "Leo constellation" and
   * "Leo zodiac sign" find different forms.
   */
  hints: readonly string[];
  /** Morph durations for this category's forms (seconds), e.g. a calmer, slower formation. */
  transition?: MorphTarget["transition"];
}

export interface VisualFormPack {
  id: string;
  categories: readonly FormCategory[];
  forms: readonly VisualFormEntry[];
}

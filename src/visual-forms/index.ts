import { celestialPack } from "./celestial";
import { VisualFormRegistry } from "./registry";
import { taoPack } from "./tao";
import type { VisualFormPack } from "./types";

export { FORM_ID, FORM_NAME_MAX, normalizeFormName, VisualFormRegistry, type FormMatch, type RenderedForm } from "./registry";
export type * from "./types";

/**
 * Every visual form pack, in the order their forms are listed to the model. A new pack (math, physics,
 * chemistry, biology, music, engineering, mythology, …) is one more entry here: its categories, its forms
 * and their renderers. Nothing else in SCF changes: show_form, validation, the resolver and the body all
 * read the registry.
 */
export const VISUAL_FORM_PACKS: readonly VisualFormPack[] = [taoPack, celestialPack];

/** The registry SCF uses. Pure and side-effect free: forms are only drawn when first shown. */
export const visualForms = new VisualFormRegistry(VISUAL_FORM_PACKS);

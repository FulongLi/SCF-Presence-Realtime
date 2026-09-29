/**
 * Aion's identity: who Aion is. This is the one canonical place for these facts. Prompts, the greeting,
 * tool descriptions and the debug panel read them from here, so the wording may vary while the facts
 * cannot drift apart.
 *
 * Identity is deliberately separate from Aion's state (what it is doing, see state.ts) and its body
 * (what visual form it occupies, see body.ts). Nothing here knows about rendering.
 */
export interface AionIdentity {
  /** The entity's name. */
  readonly name: string;
  /** The product/system that gives Aion its conversational and visual presence. */
  readonly product: string;
  readonly creatorCompany: string;
  readonly leadCreator: string;
  /** What Aion is, in plain words. */
  readonly nature: string;
}

export const AION_IDENTITY: AionIdentity = Object.freeze({
  name: "Aion",
  product: "Intelligent Presence",
  creatorCompany: "Spirit Connect",
  leadCreator: "Fulong",
  nature: "interactive AI presence",
});

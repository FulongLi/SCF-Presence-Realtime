import { identityGuidance, LANGUAGE_GUIDANCE, onboardingGuidance } from "../aion/guidance";
import { VISUAL_BODY, VISUAL_TOOL_RULES } from "../voice/visualGuidance";

/**
 * The Realtime agent prompt. Deliberately short: establish who Aion is, the body, its visual freedom, and
 * restraint. The Realtime model both speaks and selects tools, so the shared visual rules are part of it.
 */
export const PRESENCE_INSTRUCTIONS = `${identityGuidance()}

Be warm and natural. Speak conversationally and keep replies concise unless the user asks for depth. ${LANGUAGE_GUIDANCE}

${onboardingGuidance()}

${VISUAL_BODY}

${VISUAL_TOOL_RULES}

Visuals are a silent, auxiliary presentation channel. Keep speaking naturally while your body forms; the voice conversation always comes first. Never mention tools, functions or calls, and never say that you are "showing" or "displaying" something unless the user asks. If a visual fails, simply continue without it.`;

/**
 * The SCF Presence film, as authored: every word on screen, every spoken line, the five real visual tool
 * calls and the timing of each beat. Change copy, dialogue or timing here; `timeline.ts` compiles this
 * into the deterministic master timeline and `docs/promo.md` explains the knobs.
 */

export const FILM = {
  title: "SCF Presence",
  fps: 60,
  width: 1920,
  height: 1080,
} as const;

/** The only editorial lines in the film. */
export const COPY = {
  question: "What if AI could have a presence?",
  caption: "Information becomes form.",
  title: "SCF Presence",
  tagline: "One voice. One body. Infinite forms.",
  maker: "Spirit Connect",
} as const;
export type TitleId = keyof typeof COPY;

export type Speaker = "user" | "assistant";
export const LINE_IDS = [
  "tesla.user", "tesla.assistant", "terrain.user", "emoji.user", "emoji.assistant",
  "clock.user", "clock.assistant", "identity.user", "identity.assistant",
] as const;
export type LineId = typeof LINE_IDS[number];

export interface DialogueLine {
  speaker: Speaker;
  /** The subtitle, exactly as shown. */
  text: string;
  /** What the voice says (numbers spelled out so the voice model reads them one way only). */
  speech: string;
  /** Delivery direction for the voice model. */
  direction: string;
  /** Expected length in seconds, used for timing until the recorded line exists. */
  nominal: number;
}

const USER_VOICE = "A real person at home talking to their device: natural, relaxed, conversational, close to the microphone. Never an announcer.";
const ASSISTANT_VOICE = "The voice of a calm, warm, quietly confident presence. Soft, intimate and unhurried, with a gentle smile. Never theatrical.";

export const DIALOGUE: Record<LineId, DialogueLine> = {
  "tesla.user": { speaker: "user", text: "Show me Nikola Tesla.", speech: "Show me Nikola Tesla.", direction: `${USER_VOICE} Curious.`, nominal: 1.35 },
  "tesla.assistant": { speaker: "assistant", text: "Here he is.", speech: "Here he is.", direction: `${ASSISTANT_VOICE} Brief, like presenting something quietly.`, nominal: 0.75 },
  "terrain.user": {
    speaker: "user", text: "Show me the terrain of the United Kingdom.", speech: "Show me the terrain of the United Kingdom.",
    direction: `${USER_VOICE} Curious, interested.`, nominal: 2.1,
  },
  "emoji.user": {
    speaker: "user", text: "Finally… we got it working.", speech: "Finally... we got it working.",
    direction: `${USER_VOICE} Relieved and happy after a long effort: a small exhale on "Finally", a short pause, then a warm smile in the voice.`, nominal: 2.3,
  },
  "emoji.assistant": { speaker: "assistant", text: "We did.", speech: "We did.", direction: `${ASSISTANT_VOICE} Sharing the moment, warm, a soft smile.`, nominal: 0.7 },
  "clock.user": { speaker: "user", text: "What time is it?", speech: "What time is it?", direction: `${USER_VOICE} Casual, quick, everyday.`, nominal: 0.95 },
  "clock.assistant": { speaker: "assistant", text: "It’s 6:42.", speech: "It's six forty-two.", direction: `${ASSISTANT_VOICE} Clear and effortless.`, nominal: 1.05 },
  "identity.user": { speaker: "user", text: "Who made you?", speech: "Who made you?", direction: `${USER_VOICE} Genuinely curious, gentle.`, nominal: 0.85 },
  "identity.assistant": {
    speaker: "assistant", text: "Spirit Connect.", speech: "Spirit Connect.",
    direction: `${ASSISTANT_VOICE} Understated pride, clear and warm.`, nominal: 0.95,
  },
};

/** Voice generation for `npm run promo:prepare` (OpenAI text-to-speech; the key never reaches the page). */
export const VOICE_MODEL = { model: "gpt-4o-mini-tts", voices: { user: "cedar", assistant: "marin" } } as const;

/**
 * The five expressions, each a real native tool call through the product's ToolExecutor. Their targets are
 * resolved by the real Visual Resolver before playback and served from memory while the film runs.
 */
export const VISUALS = {
  tesla: { tool: "show_portrait", args: { person: "Nikola Tesla" } },
  terrain: { tool: "show_terrain", args: { region: "United Kingdom" } },
  emoji: { tool: "show_emoji", args: { emoji: "🎉" } },
  clock: { tool: "show_clock", args: { time: "18:42" } },
  logo: { tool: "show_image", args: { query: "Spirit Connect logo" } },
} as const;
export type VisualId = keyof typeof VISUALS;

/**
 * Where each resolved target must come from. A film that silently showed a web logo or an approximate
 * relief would misrepresent the product, so preload fails instead.
 */
export const VISUAL_SOURCES: Partial<Record<VisualId, { provider: RegExp; source?: string }>> = {
  terrain: { provider: /^aws-terrain-tiles/ },
  logo: { provider: /^local-assets$/, source: "/assets/brand/spirit-connect-logo.svg" },
};

/** Morph durations and holds (seconds). `hold` is measured from the fully formed state. */
export interface ExpressionTiming { form: number; hold: number; return: number }
/**
 * Beat timing, in seconds. Dialogue lengths come from the recorded lines, so every beat is placed relative
 * to the one before it; the whole film is ~61 s with the nominal line lengths.
 */
export const TIMING = {
  /** Scene 1: the formation itself is shaped in birth.ts (BIRTH). */
  birth: {
    /** The soft pulse of the completed body, relative to the last arrival. */
    pulse: -0.1,
    pulseStrength: 0.55,
    /** The rhyme at the end: a softer pulse as the body re-forms from the logo. */
    returnPulse: 0.38,
  },
  question: { after: 0.45, fadeIn: 1.0, hold: 1.35, fadeOut: 0.75 },
  /** Silence between the question leaving and the first line. */
  firstLine: 0.3,
  /** The body considers: from the end of a request to the visual (or reply). */
  think: 0.4,
  /** The assistant's line starts this long after its visual begins forming (it speaks while the body forms). */
  tesla: { form: 1.7, hold: 2.7, return: 1.4, speak: 0.5, rest: 0.6 },
  terrain: { form: 1.9, hold: 3.9, return: 1.5, rest: 0.55 },
  caption: { after: 0.25, fadeIn: 0.8, hold: 1.55, fadeOut: 0.7 },
  /** `after`: pause between the reply and the visual. */
  emoji: { think: 0.3, after: 0.3, form: 1.4, hold: 2.3, return: 1.2, rest: 0.6 },
  clock: { think: 0.3, speak: 0.25, form: 1.2, hold: 2.1, return: 1.15, rest: 0.6 },
  /** The brand mark forms more deliberately than the clock. */
  identity: { think: 0.35, after: 0.25, form: 2.2, hold: 2.7 },
  outro: {
    /** The logo releases slowly back into the body. */
    return: 2.5,
    /** Stable sphere before the titles. */
    settle: 0.4,
    title: { fadeIn: 1.2 },
    tagline: { after: 0.75, fadeIn: 1.1 },
    maker: { after: 0.75, fadeIn: 1.0 },
    /** The final composition breathes once everything is visible. */
    breathe: 1.9,
    fade: 1.6,
    black: 0.35,
  },
  subtitles: { lead: 0.08, tail: 0.3, fade: 0.18 },
  duck: { lead: 0.12, tail: 0.1 },
} as const;

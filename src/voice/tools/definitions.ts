import { AION_BODIES, PERSISTENT_BODIES } from "../../aion/body";
import { AION_IDENTITY } from "../../aion/identity";
import { IMAGE_INTENTS, SYMBOL_NAMES, TERRAIN_STYLES } from "../../visual-actions/types";
import { FORM_NAME_MAX, visualForms } from "../../visual-forms";

/**
 * SCF's visual function tools: the AI's intentional channel to its particle body. This is the one
 * canonical definition for every voice backend — declared on the Realtime session (`session.tools`)
 * and on GPT-Live's Responses backend (`delegation.responses.tools`) — and every call is executed in
 * the browser by the same ToolExecutor. No MCP, no relay, no transcript inference. Keep the set
 * deliberately small: two open tools (show_image, show_terrain) backed by the Visual Resolver, one tool
 * for SCF's own visual language (show_form, every registered visual form), one open expressive tool
 * (show_emoji, any single emoji, drawn locally), plus a few convenience shapes. `set_body_form` is the one
 * tool that is not a temporary visual: it changes Aion's persistent body (sphere or figure).
 */
export const VISUAL_TOOL_NAMES = [
  "show_image", "show_terrain", "show_form",
  "show_clock", "show_portrait", "show_number", "show_text", "show_symbol", "show_emoji", "return_to_sphere",
  "set_body_form",
] as const;
export type VisualToolName = typeof VISUAL_TOOL_NAMES[number];

export const isVisualToolName = (name: unknown): name is VisualToolName =>
  typeof name === "string" && (VISUAL_TOOL_NAMES as readonly string[]).includes(name);

/**
 * A function tool. The same shape is accepted by GA Realtime (`session.tools[]`) and by the Responses
 * function schema GPT-Live uses for `delegation.responses.tools[]`.
 */
export interface VisualFunctionTool {
  type: "function";
  name: VisualToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
}

const object = (properties: VisualFunctionTool["parameters"]["properties"] = {}, required: string[] = []) =>
  ({ type: "object" as const, properties, required, additionalProperties: false as const });

/** Every registered form id, grouped by category: generated from the registry, so a new pack needs no edit here. */
export function formCatalog(registry = visualForms): string {
  return registry.categories()
    .map(category => `${category.label}: ${registry.forms().filter(form => form.category === category.id).map(form => form.id).join(", ")}`)
    .join(". ");
}

/** The variants forms declare, forms with the same set grouped together; the first is the default. */
export function formVariantCatalog(registry = visualForms): string {
  const groups = new Map<string, string[]>();
  for (const form of registry.forms()) {
    if (!form.variants?.length) continue;
    const key = form.variants.map((variant, index) => `${variant.id}${index ? "" : " (default)"}`).join(" or ");
    groups.set(key, [...(groups.get(key) ?? []), form.id]);
  }
  return [...groups].map(([variants, forms]) => `${forms.join(", ")}: ${variants}`).join("; ");
}

export const visualTools: readonly VisualFunctionTool[] = [
  {
    type: "function",
    name: "show_image",
    description: "Form a picture of almost anything with your particle body: a person, vehicle, product, object, "
      + "animal, building, place, artwork, logo, map or a reference image of an idea. SCF first checks its curated local "
      + `assets (such as the ${AION_IDENTITY.creatorCompany} company logo), then searches open image sources. Use when seeing it `
      + "materially helps, e.g. the user asks what something looks like or wants to see it.",
    parameters: object({
      query: { type: "string", description: `What to show, as a short specific search phrase, e.g. "Tesla Model Y", "futuristic concept car", "Eiffel Tower at night", "${AION_IDENTITY.creatorCompany} logo". At most 100 characters, no URLs.` },
      intent: { type: "string", enum: [...IMAGE_INTENTS], description: "What kind of picture this is; helps choose sources and framing. Default general." },
    }, ["query"]),
  },
  {
    type: "function",
    name: "show_terrain",
    description: "Form the terrain of a real region as a raised relief with your particle body, from real elevation data: "
      + "mountains rise, valleys sink. Use for the terrain, topography, relief or landscape shape of a country, "
      + "region, island, mountain range or other place.",
    parameters: object({
      region: { type: "string", description: "The place, e.g. \"Wales\", \"United Kingdom\", \"Swiss Alps\", \"Grand Canyon\". At most 80 characters." },
      style: { type: "string", enum: [...TERRAIN_STYLES], description: "Shading: terrain (default), topography (contour bands), relief (strong shading), heightmap (height only)." },
    }, ["region"]),
  },
  {
    type: "function",
    name: "show_form",
    description: "Form a symbol or figure from SCF's own visual language directly with your particle body. It is drawn "
      + "procedurally on the device, with no image search: Taoist symbols (the yin-yang/taiji, the yin and yang lines, the "
      + "eight trigrams 乾 兑 离 震 巽 坎 艮 坤 and the bagua), constellations as star maps, the twelve zodiac signs and the "
      + "planetary symbols. Always prefer it to show_image for these. Pass a form id from the list, or a plain name in "
      + "English or Chinese (\"yin yang\", \"Orion\", \"Leo zodiac sign\", \"猎户座\").",
    parameters: object({
      form: { type: "string", description: `A form id or its common name; at most ${FORM_NAME_MAX} characters. Form ids: ${formCatalog()}.` },
      variant: { type: "string", description: `Optional; omit for the default. ${formVariantCatalog()}.` },
    }, ["form"]),
  },
  {
    type: "function",
    name: "show_clock",
    description: "Form a clock face showing a time with your particle body. Use when seeing a time helps: "
      + "the user asks what time it is, or a specific time matters to the answer. Omit `time` to show the "
      + "user's current local time; the result tells you that time so you can say it.",
    parameters: object({
      time: { type: "string", description: "Optional 24-hour time as HH:MM, e.g. \"15:42\". Omit for the current local time." },
    }),
  },
  {
    type: "function",
    name: "show_portrait",
    description: "Form a portrait of a real, recognizable person with your particle body, from public photos "
      + "(Wikipedia, then other open image sources). Use when the user wants to see what someone looks like, "
      + "or when a portrait materially helps the answer. Do not call just because a name appears in conversation.",
    parameters: object({
      person: { type: "string", description: "Full, unambiguous name of the person, e.g. \"Nikola Tesla\"." },
    }, ["person"]),
  },
  {
    type: "function",
    name: "show_number",
    description: "Show one short, key number with your particle body (e.g. 42%, 84, 23°C, £28,000, 3.14). "
      + "Use only for the single number that is the heart of the answer, not for every number mentioned.",
    parameters: object({
      value: { type: "string", description: "The number with an optional sign, currency, % or unit; at most 12 characters." },
    }, ["value"]),
  },
  {
    type: "function",
    name: "show_text",
    description: "Show one short word or label with your particle body. Use sparingly, when a single word "
      + "is the answer or a useful anchor (e.g. a city, a name of a thing).",
    parameters: object({
      value: { type: "string", description: "One word or a very short label; at most 16 characters, no URLs or markup." },
    }, ["value"]),
  },
  {
    type: "function",
    name: "show_symbol",
    description: "Show a simple symbol with your particle body, e.g. a check for yes/correct, a cross for "
      + "no/wrong, a heart, a star, or an arrow for a direction or trend.",
    parameters: object({
      symbol: { type: "string", enum: [...SYMBOL_NAMES], description: "Which symbol to show." },
    }, ["symbol"]),
  },
  {
    type: "function",
    name: "show_emoji",
    description: "Briefly form one emoji with your particle body as a short expressive reaction, like a gesture: "
      + "e.g. 🎉 for a celebration, 😂 amusement, 🤔 thinking, 😮 surprise, 👍 approval, 💡 an idea, 🚀 a launch. "
      + "Also use it when the user asks to see an emoji. It is drawn instantly on the device (no image search). "
      + "Use it only when a reaction genuinely adds to the moment, never on every reply or as filler.",
    parameters: object({
      emoji: { type: "string", description: "Exactly one Unicode emoji, e.g. \"😊\", \"❤️\", \"👍🏻\", \"👨‍🚀\", \"🇬🇧\". No text, and not several emoji." },
    }, ["emoji"]),
  },
  {
    type: "function",
    name: "return_to_sphere",
    description: "Immediately end the temporary visual, e.g. when it is no longer relevant: your body returns to its "
      + "current persistent form (the sphere or the figure). It does not change that form; use set_body_form for that.",
    parameters: object(),
  },
  {
    type: "function",
    name: "set_body_form",
    description: "Change your persistent body, the form you rest in between visuals: "
      + `${PERSISTENT_BODIES.map(body => `"${body.id}" (${body.description})`).join(", ")}. `
      + "Use it only when the user asks you to take a form, e.g. \"take a human form\", \"become a figure\", "
      + "\"go back to the sphere\", \"变成人形\", \"回到球体\". It stays until changed; every temporary visual returns to it.",
    parameters: object({
      form: { type: "string", enum: [...AION_BODIES], description: "The persistent body to take." },
    }, ["form"]),
  },
];

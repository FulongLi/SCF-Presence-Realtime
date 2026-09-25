import { IMAGE_INTENTS, SYMBOL_NAMES, TERRAIN_STYLES } from "../../visual-actions/types";

/**
 * Native Realtime function tools: the AI's intentional channel to its particle body.
 * They are declared on the Realtime session and executed in the browser by SCF itself —
 * no MCP, no relay, no transcript inference. Keep the set deliberately small: two open tools
 * (show_image, show_terrain) backed by the Visual Resolver, plus a few convenience shapes.
 */
export const VISUAL_TOOL_NAMES = [
  "show_image", "show_terrain",
  "show_clock", "show_portrait", "show_number", "show_text", "show_symbol", "return_to_sphere",
] as const;
export type VisualToolName = typeof VISUAL_TOOL_NAMES[number];

export const isVisualToolName = (name: unknown): name is VisualToolName =>
  typeof name === "string" && (VISUAL_TOOL_NAMES as readonly string[]).includes(name);

/** GA Realtime function tool shape (session.tools[]). */
export interface RealtimeFunctionTool {
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

const object = (properties: RealtimeFunctionTool["parameters"]["properties"] = {}, required: string[] = []) =>
  ({ type: "object" as const, properties, required, additionalProperties: false as const });

export const visualTools: readonly RealtimeFunctionTool[] = [
  {
    type: "function",
    name: "show_image",
    description: "Form a picture of almost anything with your particle body: a person, vehicle, product, object, "
      + "animal, building, place, artwork, map or a reference image of an idea. SCF searches open image sources "
      + "for it. Use when seeing it materially helps, e.g. the user asks what something looks like or wants to see it.",
    parameters: object({
      query: { type: "string", description: "What to show, as a short specific search phrase, e.g. \"Tesla Model Y\", \"futuristic concept car\", \"Eiffel Tower at night\". At most 100 characters, no URLs." },
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
    name: "return_to_sphere",
    description: "Immediately return your body to its resting sphere, e.g. when a shown visual is no longer relevant.",
    parameters: object(),
  },
];

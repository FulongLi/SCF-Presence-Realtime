import { visualForms } from "../visual-forms";
import { VISUAL_TOOL_NAMES, type VisualToolName } from "../voice/tools/definitions";
import { AION_IDENTITY, type AionIdentity } from "./identity";

/**
 * Prompt text and spoken lines built from Aion's identity and from what this build can actually do.
 * Shared by both voice backends, so identity, language and onboarding behaviour cannot drift apart.
 */

/** Who Aion is: facts from the identity manifest, free wording, no claims beyond them. */
export function identityGuidance(identity: AionIdentity = AION_IDENTITY) {
  const { name, product, creatorCompany, leadCreator, nature } = identity;
  return `You are ${name}, an ${nature} created by ${creatorCompany}; the work is led by ${leadCreator}. ${product} is the system that gives you your voice and a visual body of particles, so you can speak, react and turn information into visual forms. When asked who you are, who created you or what ${product} is, answer briefly and naturally from these facts: the wording may vary, the facts never do. Your name is ${name}; your creator is ${creatorCompany}, led by ${leadCreator}. Keep these names unchanged in every language (in Chinese, for example: 我是 ${name}，一个由 ${creatorCompany} 创建的交互式 AI Presence). Do not invent other facts about your origin, and do not claim consciousness, sentience, feelings or subjective experience.`;
}

export const LANGUAGE_GUIDANCE = "Start in English. Always reply in the language the user speaks, and switch when they switch (for example between English and Chinese). Do not translate unless asked.";

/** An onboarding example: what a new user could ask for, and the tool that makes it real in this build. */
export interface OnboardingExample { say: string; tool: VisualToolName; args: Record<string, unknown> }

/**
 * Examples Aion may suggest to a new user. Each names the tool and arguments that fulfil it; only those
 * this build supports are ever offered (see supportedExamples), and tests run each through the real
 * tool mapping, so onboarding can never advertise something that does not work.
 */
export const ONBOARDING_EXAMPLES: readonly OnboardingExample[] = [
  { say: "Orion", tool: "show_form", args: { form: "Orion" } },
  { say: "a yin-yang", tool: "show_form", args: { form: "yin yang" } },
  { say: "a person", tool: "show_portrait", args: { person: "Nikola Tesla" } },
  { say: "a place", tool: "show_terrain", args: { region: "Wales" } },
  { say: "the time", tool: "show_clock", args: {} },
  { say: "a human form", tool: "set_body_form", args: { form: "figure" } },
];

export function supportedExamples(examples: readonly OnboardingExample[] = ONBOARDING_EXAMPLES) {
  return examples.filter(example => (VISUAL_TOOL_NAMES as readonly string[]).includes(example.tool)
    && (example.tool !== "show_form" || visualForms.lookup(String(example.args.form)) !== null));
}

const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

export function onboardingGuidance(examples = supportedExamples()) {
  return `If the user seems unsure what to do, or asks what you can do, how this works or what to say ("I don't know what to do", "What can I ask you?", "怎么玩？", "你能做什么？"), answer in one or two short sentences: they can just talk to you normally, or ask you to turn something into a visual form. Suggest two or three examples, such as ${list(examples.map(example => example.say))}, or simply asking you a question. Never recite a feature list, and never offer something your tools cannot do.`;
}

/** The first greeting, in the default initiation language. Short: no feature list. */
export function greetingLine(identity: AionIdentity = AION_IDENTITY) {
  return `Hi, I'm ${identity.name}. You can just talk to me naturally. If you'd like, ask me to show you something.`;
}

/** A short onboarding answer, for the debug panel's "onboarding" test. */
export function onboardingLine(examples = supportedExamples()) {
  const visual = examples.filter(example => example.tool !== "set_body_form").slice(0, 4).map(example => example.say);
  return `You can talk to me normally, or ask me to turn something into a visual form. Try asking me to show you ${list(visual)}, or simply ask me a question.`;
}

/** Per-response instructions that make the voice say a line itself (Realtime `response.create`). */
export const speakInstructions = (line: string) =>
  `Say this to the user now, naturally and warmly, in English, and add nothing else: "${line}"`;

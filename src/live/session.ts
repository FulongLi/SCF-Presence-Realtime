import { visualTools, type VisualFunctionTool } from "../voice/tools/definitions";
import { LIVE_FRONTEND_CLIENT_EVENTS } from "./events";
import { LIVE_BACKEND_INSTRUCTIONS, LIVE_VOICE_INSTRUCTIONS } from "./instructions";

/**
 * GPT-Live session configuration (the `session` object of POST /v1/live/sessions). Built on the server
 * so the browser never chooses the model, prompts or tools.
 */
export const LIVE_DEFAULTS = {
  model: "gpt-live-1",
  /** GPT-Live's guidance: start with GPT-5.6 Terra; GPT-5.6 Luna for cost-sensitive workloads. */
  backendModel: "gpt-5.6-terra",
  voice: "marin",
} as const;

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface LiveSessionOptions {
  model: string;
  backendModel: string;
  voice: string;
  /** Optional backend reasoning effort; omitted lets the backend model use its default. */
  reasoningEffort?: ReasoningEffort;
}

export interface LiveSessionConfig {
  model: string;
  instructions: string;
  audio: { output: { voice: string } };
  delegation: {
    type: "responses";
    responses: {
      model: string;
      instructions: string;
      tools: readonly VisualFunctionTool[];
      tool_choice: "auto";
      parallel_tool_calls: false;
      reasoning?: { effort: ReasoningEffort };
    };
  };
  /** The browser is an untrusted frontend: it may only return tool results, continue, and close. */
  client: { data_channel: { allowed_client_events: string[] } };
}

const MODEL = /^[a-z0-9][a-z0-9.\-]{2,63}$/;
const VOICE = /^[a-z0-9_\-]{2,40}$/i;

/** Invalid values fall back to defaults rather than being forwarded, so a typo cannot inject session fields. */
export function liveOptionsFromEnv(env: Record<string, string | undefined>): LiveSessionOptions {
  const pick = (value: string | undefined, pattern: RegExp, fallback: string) =>
    value && pattern.test(value.trim()) ? value.trim() : fallback;
  const effort = env.OPENAI_LIVE_BACKEND_REASONING?.trim().toLowerCase();
  return {
    model: pick(env.OPENAI_LIVE_MODEL, MODEL, LIVE_DEFAULTS.model),
    backendModel: pick(env.OPENAI_LIVE_BACKEND_MODEL, MODEL, LIVE_DEFAULTS.backendModel),
    voice: pick(env.OPENAI_LIVE_VOICE, VOICE, LIVE_DEFAULTS.voice),
    reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(effort ?? "") ? effort as ReasoningEffort : undefined,
  };
}

/**
 * Responses delegation with SCF's visual tools: GPT-Live listens, speaks and decides when help is needed;
 * the Responses backend reasons and selects tools; the browser executes them with the same ToolExecutor
 * the Realtime path uses. The tool list is the canonical `visualTools` — no second schema. Tool calls are
 * sequential (the migration guide's recommended starting point, and one visual at a time anyway).
 * WebRTC negotiates the audio format, so `audio.format` is omitted.
 */
export function buildLiveSessionConfig(options: LiveSessionOptions): LiveSessionConfig {
  return {
    model: options.model,
    instructions: LIVE_VOICE_INSTRUCTIONS,
    audio: { output: { voice: options.voice } },
    delegation: {
      type: "responses",
      responses: {
        model: options.backendModel,
        instructions: LIVE_BACKEND_INSTRUCTIONS,
        tools: visualTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      },
    },
    client: { data_channel: { allowed_client_events: [...LIVE_FRONTEND_CLIENT_EVENTS] } },
  };
}

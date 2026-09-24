import { PRESENCE_INSTRUCTIONS } from "./instructions";
import { visualTools } from "./tools/definitions";

/**
 * GA Realtime session configuration (the `session` object of POST /v1/realtime/client_secrets).
 * Built on the server so the browser never chooses the model, instructions or tools; the ephemeral
 * client secret is bound to exactly this session.
 */
export const REALTIME_DEFAULTS = {
  model: "gpt-realtime-2.1",
  voice: "marin",
  turnDetection: "semantic_vad",
  eagerness: "auto",
} as const;

export type TurnDetectionType = "semantic_vad" | "server_vad";
export type Eagerness = "low" | "medium" | "high" | "auto";

export interface SessionOptions {
  model: string;
  voice: string;
  turnDetection: TurnDetectionType;
  eagerness: Eagerness;
  /** Optional input transcription model; transcripts are kept in memory for ?debug=1 only. */
  transcriptionModel?: string;
  instructions?: string;
}

export type TurnDetectionConfig =
  | { type: "semantic_vad"; eagerness: Eagerness; create_response: true; interrupt_response: true }
  | { type: "server_vad"; create_response: true; interrupt_response: true; threshold: number; prefix_padding_ms: number; silence_duration_ms: number };

export interface RealtimeSessionConfig {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities: ["audio"];
  audio: {
    input: {
      noise_reduction: { type: "near_field" };
      turn_detection: TurnDetectionConfig;
      transcription?: { model: string };
    };
    output: { voice: string };
  };
  tools: typeof visualTools;
  tool_choice: "auto";
}

const MODEL = /^[a-z0-9][a-z0-9.\-]{2,63}$/;
const VOICE = /^[a-z0-9_\-]{2,40}$/i;

/**
 * Reads optional configuration from environment-style values. Invalid values fall back to defaults
 * rather than being forwarded, so a typo cannot inject arbitrary session fields.
 */
export function sessionOptionsFromEnv(env: Record<string, string | undefined>): SessionOptions {
  const pick = (value: string | undefined, pattern: RegExp, fallback: string) =>
    value && pattern.test(value.trim()) ? value.trim() : fallback;
  const turn = env.OPENAI_REALTIME_TURN_DETECTION?.trim();
  const eagerness = env.OPENAI_REALTIME_VAD_EAGERNESS?.trim();
  const transcription = env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim();
  return {
    model: pick(env.OPENAI_REALTIME_MODEL, MODEL, REALTIME_DEFAULTS.model),
    voice: pick(env.OPENAI_REALTIME_VOICE, VOICE, REALTIME_DEFAULTS.voice),
    turnDetection: turn === "server_vad" || turn === "semantic_vad" ? turn : REALTIME_DEFAULTS.turnDetection,
    eagerness: eagerness === "low" || eagerness === "medium" || eagerness === "high" || eagerness === "auto"
      ? eagerness : REALTIME_DEFAULTS.eagerness,
    transcriptionModel: transcription && MODEL.test(transcription) ? transcription : undefined,
  };
}

export function turnDetectionConfig(options: Pick<SessionOptions, "turnDetection" | "eagerness">): TurnDetectionConfig {
  // Both modes create a response when the user's turn ends and cancel an ongoing response when the
  // user starts speaking: this is what makes natural barge-in work over WebRTC.
  return options.turnDetection === "server_vad"
    ? { type: "server_vad", create_response: true, interrupt_response: true, threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
    : { type: "semantic_vad", eagerness: options.eagerness, create_response: true, interrupt_response: true };
}

export function buildSessionConfig(options: SessionOptions): RealtimeSessionConfig {
  return {
    type: "realtime",
    model: options.model,
    instructions: options.instructions ?? PRESENCE_INSTRUCTIONS,
    output_modalities: ["audio"],
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        turn_detection: turnDetectionConfig(options),
        ...(options.transcriptionModel ? { transcription: { model: options.transcriptionModel } } : {}),
      },
      output: { voice: options.voice },
    },
    tools: visualTools,
    tool_choice: "auto",
  };
}

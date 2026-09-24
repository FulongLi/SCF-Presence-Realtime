# Architecture

One test decides every design choice here: **does this make SCF feel like one AI with one living body?**

## Code map

```text
src/
  app/
    page.tsx, layout.tsx, globals.css
    api/realtime/token/route.ts   server-only: POST → ephemeral client secret
  server/realtimeToken.ts         pure token logic (origin check, safety id, upstream call)
  realtime/
    session.ts                    GA session config (model, voice, VAD, tools, instructions)
    instructions.ts               the agent prompt ("SCF is your visual body")
    client.ts                     RealtimeClient: WebRTC peer + data channel lifecycle, reconnect
    transport.ts                  browser environment: token fetch, SDP exchange with /v1/realtime/calls
    events.ts                     normalizes GA server events; client event types
    state.ts                      small state reducer + Presence hints + session phase
    conversation.ts               ToolCallLoop: the function-calling lifecycle
    identity.ts                   anonymous installation id (for the hashed safety identifier)
    tools/definitions.ts          the six native function tools
    tools/executor.ts             args → VisualAction → validate → VisualActionController
    tools/results.ts              concise function_call_output payloads
  audio/
    microphone/                   MicrophoneListener (track clone), VAD, emphasis
    assistant.ts                  remote track: <audio> playback + analyser
    analyser.ts, spectrum.ts      RMS envelope, 16 log-spaced bands
  presence/
    controller.ts                 PresenceController: owns the whole voice ⇄ body loop
    Presence.tsx, StageNotice.tsx React surface (particle stage + minimal notices)
    PresenceEngine.ts             modes and smoothed signal for the body
    focus.ts, signal.ts, strings.ts
  particle/                       WebGPU runtime, TSL physics, rendering, quality (ported)
  visual-actions/                 schema, validation, controller, resolvers, portrait, targets (ported)
  dev/debugPanel.ts               ?debug=1 diagnostics
```

## Session lifecycle

`src/realtime/state.ts` has a connection state and derives one session phase from it:

```text
disconnected → connecting → connected ⇄ { listening → thinking → speaking → listening … }
                    ↑            │
                    └ reconnecting ┘ (unexpected loss, bounded) → error
                                 └ ended (idle timeout; tap to resume)
```

Only what SCF needs is tracked: `userSpeaking`, `awaitingSince`, `responseActive`, `audioActive`, `toolsActive`, plus counters (responses, interruptions, token usage). OpenAI keeps the conversation itself. SCF keeps no copy of it.

| Realtime server event (GA) | Effect |
| --- | --- |
| `session.created` | session id and model for diagnostics |
| `input_audio_buffer.speech_started` / `speech_stopped` | user turn start and end (OpenAI VAD) |
| `response.created` / `response.done` | response active; status, `status_details.reason`, output items, usage |
| `output_audio_buffer.started` / `stopped` / `cleared` | WebRTC playback window; `cleared` means barge-in |
| `response.function_call_arguments.delta` / `.done` | tool argument assembly and execution |
| `response.output_audio_transcript.done`, `conversation.item.input_audio_transcription.completed` | optional in-memory transcript |
| `error`, `rate_limits.updated` | diagnostics |

## Presence state mapping

Two VADs have separate jobs. **OpenAI's VAD controls conversational turns. SCF's local VAD controls the body.**

| Body state | Driven by |
| --- | --- |
| **Idle** (slow breathing, subtle circulation, slight asymmetry) | no activity |
| **Listening** (inward gathering, contraction, coherence, slight brightening) | the local microphone VAD at once (~120 ms attack), held by OpenAI's `speech_started…speech_stopped`. The user's loudness drives the gathering. |
| **Acoustic focus** (brief stronger contraction and stillness, soft release) | local emphasis detection (stressed syllables, a peak before a pause, phrase endings) through `FocusImpulse` |
| **Thinking** (interior turbulence, rotation, travelling fronts) | authoritative Realtime timing: from `speech_stopped` or `response.created` until assistant audio plays, while a tool runs, and between a tool-only response and its continuation. Bounded at 6 s if no response starts. |
| **Speaking** (radial spectrum tufts, travelling accents, circulation) | the **actual remote assistant audio**: RMS amplitude plus 16 spectrum bands from the remote WebRTC track, fed to the existing `SpeechMotion` engine |

Precedence in `PresenceEngine.sample()`: OpenAI says the user is speaking → listening (this is barge-in). Otherwise audible assistant audio → speaking. Otherwise local voice → listening. Otherwise a response is expected or a tool is running → thinking. Otherwise idle.

While the assistant is audible, the local microphone is treated as echo. Barge-in is left to OpenAI's VAD, which is also what cancels the response.

Without a live session (e.g. during reconnect), the engine falls back to the original transcript-free inference: a finished utterance starts a bounded "thinking".

## Audio

- **One microphone request.** `requestMicrophone()` calls `getUserMedia` once with echo cancellation, noise suppression and AGC. The original track goes to the `RTCPeerConnection`. A **clone** (same source, no second prompt) goes to `MicrophoneListener`, which uses `MediaStreamTrackProcessor` where available and an `AnalyserNode` otherwise. Stopping analysis never stops what OpenAI hears, and the reverse.
- **Assistant audio.** The remote track plays through an `<audio>` element. Element playback gets echo cancellation, and Chrome needs a remote WebRTC stream attached to an element before Web Audio can read it. The same stream also feeds an `AudioMeter` (FFT 2048, RMS envelope, `SpectrumEnvelope` with 16 log-spaced bands from 60 Hz to 18 kHz) that is never connected to the speakers, so nothing plays twice.
- **Autoplay.** If an `AudioContext` cannot start without a gesture, the page waits for one tap before connecting, rather than letting the AI talk silently.

## Native function tools

```text
Realtime model ── response.function_call_arguments.done {name, call_id, arguments}
      │
      ▼
ToolCallLoop ── dedupe by call_id (response.done output is a fallback)
      │
      ▼
ToolExecutor ── JSON.parse → toolCallToVisualAction → validateVisualAction → VisualActionController.submit
      │          (voice keeps playing; waits at most 1.5 s, else reports "forming")
      ▼
conversation.item.create { type: "function_call_output", call_id, output: '{"ok":true,"status":"displayed"}' }
      │
      └─ if the response only called tools and never spoke, and the user is not speaking:
         response.create  (the model continues, e.g. says the time it just showed)
```

- **One schema.** Tools resolve into the existing `VisualAction` union and go through the existing validator and controller. There is no second visual schema.
- **Concurrency.** A portrait forms while the model keeps talking. `morphSpeechBlend()` fades destructive speaking forces early in the morph, and a small audio-reactive shimmer stays, so portraits, clocks and text remain readable during speech.
- **Failure** (invalid arguments, unknown tool, portrait not found, superseded): the body stays a sphere, the model gets `{ ok: false, status }`, and it continues without the visual.
- **Silence about tools.** The instructions tell the model the visual channel is auxiliary and not to be narrated. A response that already spoke gets no follow-up, so the model has no reason to comment on the tool result.

## Interruption / barge-in

Turn detection is configured with `create_response: true, interrupt_response: true`. When the user starts talking over the assistant:

1. OpenAI's VAD emits `input_audio_buffer.speech_started`, and the body switches to **listening** at once.
2. The server cancels the response and cuts unplayed audio (WebRTC: `output_audio_buffer.cleared`, then `response.done` with `status: "cancelled"`, `reason: "turn_detected"`).
3. On `cleared`, `PresenceEngine.interrupt()` ends speaking without waiting for the audio release. For 350 ms it ignores assistant audio still in the jitter buffer, and it skips the speaker-echo guard, because the user really is speaking.
4. A tool-only response that was cancelled gets no continuation. The user's new turn gets its own response.

The client sends no cancel events itself. With WebRTC, the server's own interruption handling is authoritative and it truncates the conversation correctly.

## Connection, reconnection and errors

- **Single session.** Every (re)connect bumps a generation counter and tears down the previous peer and data channel. Late callbacks from an old generation are ignored. `connect()` while connecting or connected does nothing. React StrictMode's double mount is covered by `PresenceController.stop()`.
- **Unexpected loss** (data channel closed, peer `failed`, peer `disconnected` for more than 4 s, 20 s connect timeout): tear down, clear the remote stream, reset the tool loop, clear stale speaking/thinking, then retry after 1 s, 3 s and 8 s. After that the state is `error` with a **Try again** notice.
- **Permanent errors** are not retried: `not-configured`, `invalid-api-key`, `forbidden-origin`, `rate-limited`, `upstream-rejected`, and non-401 4xx responses from the SDP exchange.
- **Microphone denied or unavailable, WebGPU unavailable, device lost, portrait not found, remote audio blocked:** each shows a one-line notice or degrades quietly. None of them stops the rest of the page.

## Server

`POST /api/realtime/token` ([route](../src/app/api/realtime/token/route.ts), [logic](../src/server/realtimeToken.ts)):

1. Refuses when no key is configured (503), when the Origin is foreign or missing (403), or when the body is malformed (400).
2. Builds the GA session: `type: "realtime"`, model, instructions, `output_modalities: ["audio"]`, `audio.input` (near-field noise reduction, turn detection, optional transcription), `audio.output.voice`, tools, `tool_choice: "auto"`.
3. Posts to `https://api.openai.com/v1/realtime/client_secrets` with `expires_after: { anchor: "created_at", seconds: 60 }` and an `OpenAI-Safety-Identifier` header (a salted hash of the installation id).
4. Returns `{ value, expiresAt, model, voice }`, with `Cache-Control: no-store`.

The server does not proxy audio, store anything, run STT/TTS/LLM, or execute tools.

## Ported from SCF-AI-Presence

**Copied with small edits** (see git history for the diff against the reference):

- `config/particleDefaults.ts`
- `particle/`: `ParticleRuntime` (semantic focus input removed), `ParticleScene`, `ParticleSystem`, `interaction/pointer`, `physics/*`, `rendering/material` and `postfx` (restrained bloom), `sphere/createSphere`, `quality` (adaptive tiers), `speechMotion`, `morphBlend`
- `presence/focus.ts`, `presence/signal.ts` (the provider-only `semanticFocus` was removed)
- `audio/analyser.ts`, `audio/spectrum.ts`, `audio/microphone/vad.ts`, `audio/microphone/emphasis.ts`
- `visual-actions/types`, `validate`, `controller`, `resolve`, `portrait/wikimedia`, `targets/points`, `targets/rasterize`
- Tests: microphone, quality, spectrum, speech motion, visual actions

**Adapted:**

- `PresenceEngine`: the provider hint is replaced by Realtime `ConversationHints` (server VAD, awaited response, tool activity) and an explicit `interrupt()` for barge-in. Inference only runs when there is no live session.
- `MicrophoneListener`: no longer calls `getUserMedia` itself. It analyses a clone of the shared stream's track.
- `strings.ts`: new setup and connection lines (en/zh).
- The debug panel is rebuilt around Realtime diagnostics and the native tool path.

**Deliberately not copied:** `extensions/presence-bridge/`, `services/mcp-relay/`, `src/bridge/`, `src/relay/`, `audio/tabShare.ts`, the local Visual Intent interpreter, TurnTracker, the ChatGPT and Grok DOM adapters, the `SCF_ACTION` parser, MCP OAuth and pairing, the Cloudflare relay, the semantic arbiter/fingerprint (every visual now has one intentional source), `optional/api-mode/` (the old chained text/TTS API mode), the static-export and GitHub Pages pipeline, and the extension build scripts.

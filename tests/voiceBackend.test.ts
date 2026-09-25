import test from "node:test";
import assert from "node:assert/strict";
import type { MicFrame } from "../src/audio/microphone/MicrophoneListener";
import { SPECTRUM_BANDS } from "../src/audio/spectrum";
import { LiveClient, type LiveEnvironment } from "../src/live/client";
import { NO_CONVERSATION, PresenceEngine, type ConversationHints } from "../src/presence/PresenceEngine";
import { PresenceController } from "../src/presence/controller";
import { RealtimeClient, type RealtimeEnvironment } from "../src/realtime/client";
import { DEFAULT_VOICE_BACKEND, parseVoiceBackend, resolveVoiceBackend } from "../src/voice/backend";

test("backend selection: ?voice= → SCF_VOICE_BACKEND → realtime; unknown values are ignored", () => {
  assert.equal(DEFAULT_VOICE_BACKEND, "realtime");
  assert.equal(resolveVoiceBackend("", undefined), "realtime");
  assert.equal(resolveVoiceBackend("", "live"), "live");
  assert.equal(resolveVoiceBackend("?voice=realtime", "live"), "realtime", "the query parameter wins for A/B testing");
  assert.equal(resolveVoiceBackend("?voice=live&debug=1", null), "live");
  assert.equal(resolveVoiceBackend("?voice=gpt-live", " LIVE "), "live", "an unknown query value falls back to the configured one");
  assert.equal(resolveVoiceBackend(new URLSearchParams("voice=bogus"), "bogus"), "realtime");
  assert.equal(parseVoiceBackend(" Realtime "), "realtime");
  assert.equal(parseVoiceBackend("sk-123"), null);
});

const FPS = 60;
function engine() {
  const e = new PresenceEngine();
  const frame: MicFrame = { voiced: false, level: 0, utterance: 0, emphasis: 0 };
  e.mic = { read: () => frame };
  const hints: ConversationHints = { ...NO_CONVERSATION, live: true };
  e.setConversation({ hints: () => hints });
  let now = 100;
  const bands = new Array(SPECTRUM_BANDS).fill(0.5);
  const run = (seconds: number, assistantLevel = 0) => {
    for (let i = 0; i < Math.round(seconds * FPS); i++) {
      now += 1 / FPS;
      if (assistantLevel) e.assistantAudio(assistantLevel, bands, now);
      e.sample(1 / FPS, now);
    }
    return e.signal.mode;
  };
  return { e, hints, frame, run };
}

test("full duplex: overlap keeps an audible assistant speaking; the audio stopping under the user hands them the floor", () => {
  const h = engine();
  h.hints.fullDuplex = true;
  assert.equal(h.run(0.5, 0.4), "speaking");
  // A backchannel while the assistant keeps talking: GPT-Live did not yield, so the body keeps speaking.
  h.hints.userSpeaking = true;
  assert.equal(h.run(0.6, 0.4), "speaking", "simultaneous user sound is not a hard cancel");
  assert.equal(h.e.cuts, 0);
  // GPT-Live yields: its track goes silent while the user is still talking (AssistantAudio keeps reporting
  // the real, now near-zero level every frame) → listening, well before the normal speaking release.
  h.frame.voiced = true;
  assert.equal(h.run(0.3, 0.001), "listening");
  assert.equal(h.e.cuts, 1, "the cut is counted as an interruption");
  h.hints.userSpeaking = false;
  h.frame.voiced = false;
  h.hints.awaitingResponse = true;
  assert.equal(h.run(0.3), "thinking", "backend work with no audible assistant is thinking");
  assert.equal(h.run(0.3, 0.4), "speaking", "audible assistant audio wins over thinking");
  // A pause between the assistant's sentences shortly after a backchannel is not a cut: the user is quiet now.
  h.hints.awaitingResponse = false;
  h.hints.userSpeaking = true;
  assert.equal(h.run(0.3, 0.001), "speaking");
  assert.equal(h.e.cuts, 1);
});

test("turn-based (Realtime) priority is unchanged: OpenAI's speech_started always means listening", () => {
  const h = engine();
  assert.equal(h.run(0.5, 0.4), "speaking");
  h.hints.userSpeaking = true;
  assert.equal(h.run(0.1, 0.4), "listening");
  assert.equal(h.e.cuts, 0, "no full-duplex logic without the hint");
});

test("reply latency is measured from the end of listening to the first audible assistant audio", () => {
  const h = engine();
  const starts: number[] = [];
  h.e.onSpeakingStart = now => starts.push(now);
  h.hints.userSpeaking = true;
  h.run(0.5);
  h.hints.userSpeaking = false;
  h.hints.awaitingResponse = true;
  h.run(0.5);
  h.run(0.2, 0.4);
  assert.equal(starts.length, 1);
  assert.ok(h.e.replyLatency !== null && Math.abs(h.e.replyLatency - 0.5) < 0.05, `latency ${h.e.replyLatency}`);
});

const never = <T>() => new Promise<T>(() => {});
const realtime: RealtimeEnvironment = {
  fetchToken: never, createPeer: () => { throw new Error("not used"); }, exchangeSdp: never,
  now: () => 0, setTimer: () => 0, clearTimer: () => {},
};
const live: LiveEnvironment = {
  createPeer: () => { throw new Error("not used"); }, createSession: never,
  now: () => 0, setTimer: () => 0, clearTimer: () => {},
};

test("the controller drives either backend through one interface and switches without touching the body", () => {
  const controller = new PresenceController({ realtime, live }, "live");
  // Read through a function: the active client changes when the backend is switched.
  const client = () => controller.client;
  assert.ok(client() instanceof LiveClient);
  assert.equal(client().backend, "live");
  assert.equal(client().hints(0).fullDuplex, true);
  const visual = controller.visual, engineRef = controller.engine, assistant = controller.assistant;
  controller.setBackend("realtime");
  assert.ok(client() instanceof RealtimeClient);
  assert.equal(controller.backend, "realtime");
  assert.equal(client().connection, "disconnected", "no microphone yet: nothing connects");
  assert.equal(controller.visual, visual);
  assert.equal(controller.engine, engineRef);
  assert.equal(controller.assistant, assistant, "one body, one audio graph, one visual controller");
  assert.deepEqual(controller.engine.sample(1 / 60, 1).mode, "idle");
  const before = client();
  controller.setBackend("realtime");
  assert.equal(client(), before, "selecting the active backend is a no-op");
  controller.stop();
});

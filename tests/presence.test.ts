import test from "node:test";
import assert from "node:assert/strict";
import { NO_CONVERSATION, PresenceEngine, type ConversationHints } from "../src/presence/PresenceEngine";
import { FocusImpulse } from "../src/presence/focus";
import type { MicFrame } from "../src/audio/microphone/MicrophoneListener";
import { SPECTRUM_BANDS } from "../src/audio/spectrum";

const FPS = 60;
function harness() {
  const engine = new PresenceEngine();
  const frame: MicFrame = { voiced: false, level: 0, utterance: 0, emphasis: 0 };
  engine.mic = { read: () => frame };
  const hints: ConversationHints = { ...NO_CONVERSATION };
  engine.setConversation({ hints: () => hints });
  let now = 100;
  const bands = new Array(SPECTRUM_BANDS).fill(0.5);
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < Math.round(seconds * FPS); i++) {
      now += 1 / FPS;
      each?.();
      engine.sample(1 / FPS, now);
      frame.emphasis = 0;
    }
    return engine.signal;
  };
  const speak = (seconds: number, level = 0.5) => {
    frame.voiced = true; frame.level = level;
    const start = frame.utterance;
    let elapsed = 0;
    return run(seconds, () => { elapsed += 1 / FPS; frame.utterance = start + elapsed; });
  };
  const silence = (seconds: number) => { frame.voiced = false; frame.level = 0; return run(seconds); };
  const assistant = (seconds: number, level = 0.4) => run(seconds, () => engine.assistantAudio(level, bands, now));
  const live = (patch: Partial<ConversationHints> = {}) => Object.assign(hints, { live: true }, patch);
  return { engine, frame, hints, live, run, speak, silence, assistant, now: () => now };
}

test("offline: a full turn is inferred from the microphone and the assistant audio alone", () => {
  const h = harness();
  assert.equal(h.silence(1).mode, "idle");
  const listening = h.speak(1.2);
  assert.equal(listening.mode, "listening");
  assert.ok(listening.focus > 0.6, "listening gathers attention");
  assert.ok(listening.userAmplitude > 0.3, "the user's loudness is followed");
  const thinking = h.silence(0.8);
  assert.equal(thinking.mode, "thinking");
  assert.ok(thinking.thinking > 0.4, "internal activity rises");
  const speaking = h.assistant(1);
  assert.equal(speaking.mode, "speaking");
  assert.ok(speaking.assistantAmplitude > 0.3);
  assert.ok(speaking.assistantBands.every(value => value > 0.4));
  assert.equal(h.silence(1).mode, "idle");
});

test("live: Realtime turn events drive listening and thinking; local VAD reacts first", () => {
  const h = harness();
  h.live();
  // The local VAD hears the user before OpenAI's speech_started arrives.
  assert.equal(h.speak(0.2).mode, "listening");
  h.live({ userSpeaking: true });
  // OpenAI still hears the turn after the local VAD has released (semantic VAD waits longer).
  assert.equal(h.silence(0.7).mode, "listening");
  h.live({ userSpeaking: false, awaitingResponse: true });
  const thinking = h.silence(0.8);
  assert.equal(thinking.mode, "thinking");
  assert.ok(thinking.thinking > 0.4);
  // Assistant audio arrives: speaking is driven by the real signal.
  h.live({ awaitingResponse: false });
  assert.equal(h.assistant(0.5).mode, "speaking");
  assert.equal(h.silence(1).mode, "idle");
});

test("live: a short cough is not a turn — thinking needs an authoritative Realtime hint", () => {
  const h = harness();
  h.live();
  h.speak(1);
  assert.equal(h.silence(1).mode, "idle", "no inferred thought while a session owns turn timing");
  h.live({ toolActive: true });
  assert.equal(h.silence(0.5).mode, "thinking", "a tool call keeps the body thinking");
});

test("barge-in: server speech_started + cleared audio switch speaking to listening immediately", () => {
  const h = harness();
  h.live();
  h.assistant(0.5);
  assert.equal(h.engine.signal.mode, "speaking");
  // The user starts talking over the assistant: OpenAI's VAD says so.
  h.live({ userSpeaking: true });
  h.frame.voiced = true; h.frame.level = 0.6; h.frame.utterance = 0.3;
  assert.equal(h.run(1 / FPS).mode, "listening");
  // output_audio_buffer.cleared → interrupt(): residual playout does not reopen speaking.
  h.engine.interrupt(h.now());
  h.live({ userSpeaking: false });
  const after = h.run(0.2, () => h.engine.assistantAudio(0.4, new Array(SPECTRUM_BANDS).fill(0.3), h.now()));
  assert.equal(after.mode, "listening", "the user's own voice keeps listening, echo guard does not apply");
  assert.ok(after.userAmplitude > 0.2);
});

test("assistant audio outranks the local microphone, and speaker echo is not the user", () => {
  const h = harness();
  h.assistant(0.5);
  h.frame.voiced = true; h.frame.level = 0.6; h.frame.utterance = 2;
  const s = h.assistant(1);
  assert.equal(s.mode, "speaking");
  assert.equal(s.userAmplitude, 0);
  assert.notEqual(h.run(0.6).mode, "listening", "residual echo right after speech does not open a turn");
});

test("a session that drops mid-speech leaves no stale speaking or thinking", () => {
  const h = harness();
  h.live({ awaitingResponse: true });
  h.assistant(0.5);
  h.engine.interrupt(h.now());
  Object.assign(h.hints, NO_CONVERSATION);
  assert.equal(h.silence(0.1).mode, "idle");
});

test("stale assistant audio from a vanished remote track is treated as silence", () => {
  const h = harness();
  h.assistant(1);
  assert.equal(h.engine.signal.mode, "speaking");
  assert.equal(h.run(1.2).mode, "idle");
});

test("acoustic emphasis while listening produces one subtle focus impulse", () => {
  const h = harness();
  h.speak(0.6);
  h.frame.emphasis = 0.8;
  let peak = 0;
  h.run(0.4, () => { peak = Math.max(peak, h.engine.signal.acousticFocus); });
  assert.ok(peak > 0.5 && peak <= 1);
  h.frame.voiced = true;
  assert.ok(h.run(1.2).acousticFocus < 0.01, "the impulse releases");
});

test("emphasis heard while the assistant speaks is ignored", () => {
  const h = harness();
  h.assistant(0.3);
  h.frame.voiced = true; h.frame.emphasis = 1;
  let peak = 0;
  h.run(0.5, () => { h.engine.assistantAudio(0.4, new Array(SPECTRUM_BANDS).fill(0), h.now()); h.frame.emphasis = 1; peak = Math.max(peak, h.engine.signal.acousticFocus); });
  assert.equal(peak, 0);
});

test("focus impulse: attack, hold, release, cooldown and fatigue", () => {
  const focus = new FocusImpulse();
  assert.equal(focus.trigger(0.1, 0), false, "too weak");
  assert.equal(focus.trigger(1, 0), true);
  assert.ok(focus.sample(0.045) > 0.2 && focus.sample(0.045) < 0.8, "rises smoothly");
  assert.equal(focus.sample(0.15), 1, "holds");
  assert.ok(focus.sample(0.6) < 1 && focus.sample(0.6) > 0);
  assert.equal(focus.sample(1.1), 0, "released");
  assert.equal(focus.trigger(1, 1), false, "cooldown prevents pumping");
  assert.equal(focus.trigger(1, 1.5), true);
  assert.ok(focus.sample(1.5 + 0.15) < 0.7, "repeated emphasis grows weaker");
  assert.equal(focus.trigger(1, 30), true);
  assert.equal(focus.sample(30.15), 1, "fatigue recovers after a quiet period");
});

test("engine output stays bounded under hostile input", () => {
  const h = harness();
  h.engine.assistantAudio(Infinity, [NaN, -4, 9], h.now());
  h.frame.level = 99; h.frame.voiced = true;
  const s = h.run(0.5);
  for (const value of [s.energy, s.focus, s.warmth, s.thinking, s.userAmplitude, s.assistantAmplitude, s.acousticFocus]) {
    assert.ok(value >= 0 && value <= 1, String(value));
  }
  assert.ok(s.assistantBands.every(value => value >= 0 && value <= 1));
});

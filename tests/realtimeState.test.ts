import test from "node:test";
import assert from "node:assert/strict";
import { parseServerEvent } from "../src/realtime/events";
import { AWAIT_RESPONSE_MS, initialState, presenceHints, reduce, sessionPhase } from "../src/realtime/state";

const server = (value: unknown) => parseServerEvent(JSON.stringify(value));
const connected = () => reduce(initialState(), { type: "connection", state: "connected" }, 0);

test("GA server events are normalized into the few things SCF needs", () => {
  assert.deepEqual(server({ type: "session.created", session: { id: "sess_1", model: "gpt-realtime-2.1" } }),
    { type: "session.ready", sessionId: "sess_1", model: "gpt-realtime-2.1" });
  assert.deepEqual(server({ type: "input_audio_buffer.speech_started", audio_start_ms: 10, item_id: "item_1" }), { type: "user.speech_started", itemId: "item_1" });
  assert.deepEqual(server({ type: "output_audio_buffer.cleared", response_id: "resp_1" }), { type: "audio.cleared", responseId: "resp_1" });
  const done = server({
    type: "response.done",
    response: {
      id: "resp_1", status: "completed",
      output: [
        { type: "message", role: "assistant", content: [] },
        { type: "function_call", call_id: "call_1", id: "item_2", name: "show_clock", arguments: "{}" },
      ],
      usage: { total_tokens: 30, input_tokens: 20, output_tokens: 10,
        input_token_details: { audio_tokens: 15, text_tokens: 5, cached_tokens: 4 }, output_token_details: { audio_tokens: 8, text_tokens: 2 } },
    },
  });
  assert.equal(done.type, "response.finished");
  if (done.type !== "response.finished") return;
  assert.equal(done.spoke, true);
  assert.deepEqual(done.functionCalls, [{ callId: "call_1", itemId: "item_2", name: "show_clock", arguments: "{}" }]);
  assert.equal(done.usage?.inputAudioTokens, 15);
  assert.deepEqual(server({ type: "response.function_call_arguments.done", response_id: "r", call_id: "c", item_id: "i", name: "show_text", arguments: "{\"value\":\"Hi\"}", output_index: 0 }),
    { type: "tool.call", responseId: "r", call: { callId: "c", itemId: "i", name: "show_text", arguments: "{\"value\":\"Hi\"}" } });
  assert.deepEqual(server({ type: "error", error: { type: "invalid_request_error", code: "x", message: "bad" } }),
    { type: "error", code: "x", message: "bad", errorType: "invalid_request_error" });
});

test("malformed or unknown events never throw", () => {
  for (const value of ["{", "null", "[]", "42", JSON.stringify({}), JSON.stringify({ type: 3 }), JSON.stringify({ type: "response.done" })]) {
    assert.equal(parseServerEvent(value).type, "ignored", value);
  }
  assert.deepEqual(parseServerEvent(JSON.stringify({ type: "response.output_audio.delta" })), { type: "ignored", name: "response.output_audio.delta" });
  assert.equal(server({ type: "response.function_call_arguments.done", response_id: "r" }).type, "ignored", "a call without call_id/name is not executed");
});

test("lifecycle: connecting → connected → listening → thinking → speaking → connected", () => {
  let state = reduce(initialState(), { type: "connection", state: "connecting" }, 0);
  assert.equal(sessionPhase(state, 0), "connecting");
  state = reduce(state, { type: "connection", state: "connected" }, 10);
  assert.equal(sessionPhase(state, 10), "connected");
  assert.equal(state.connectedAt, 10);
  state = reduce(state, server({ type: "input_audio_buffer.speech_started", item_id: "a" }), 20);
  assert.equal(sessionPhase(state, 20), "listening");
  state = reduce(state, server({ type: "input_audio_buffer.speech_stopped", item_id: "a" }), 30);
  assert.equal(sessionPhase(state, 30), "thinking", "the user's turn ended; a response is expected");
  state = reduce(state, server({ type: "response.created", response: { id: "r1" } }), 40);
  assert.equal(sessionPhase(state, 40), "thinking");
  state = reduce(state, server({ type: "output_audio_buffer.started", response_id: "r1" }), 50);
  assert.equal(sessionPhase(state, 50), "speaking");
  state = reduce(state, server({ type: "response.done", response: { id: "r1", status: "completed", output: [{ type: "message" }] } }), 60);
  assert.equal(sessionPhase(state, 60), "speaking", "audio keeps playing after response.done");
  state = reduce(state, server({ type: "output_audio_buffer.stopped", response_id: "r1" }), 70);
  assert.equal(sessionPhase(state, 70), "connected");
  assert.equal(state.responses, 1);
});

test("an awaited response that never starts stops thinking after a bound", () => {
  let state = connected();
  state = reduce(state, server({ type: "input_audio_buffer.speech_stopped" }), 1000);
  assert.equal(presenceHints(state, 1000 + AWAIT_RESPONSE_MS - 1).awaitingResponse, true);
  assert.equal(presenceHints(state, 1000 + AWAIT_RESPONSE_MS + 1).awaitingResponse, false);
});

test("interruptions are counted once, whether audio was playing or not", () => {
  let state = connected();
  state = reduce(state, server({ type: "response.created", response: { id: "r1" } }), 1);
  state = reduce(state, server({ type: "output_audio_buffer.started", response_id: "r1" }), 2);
  state = reduce(state, server({ type: "input_audio_buffer.speech_started" }), 3);
  state = reduce(state, server({ type: "output_audio_buffer.cleared", response_id: "r1" }), 4);
  state = reduce(state, server({ type: "response.done", response: { id: "r1", status: "cancelled", status_details: { reason: "turn_detected" }, output: [] } }), 5);
  assert.equal(state.interruptions, 1);
  assert.equal(state.audioActive, false);
  assert.equal(sessionPhase(state, 5), "listening");
  // Cancelled while still thinking (no audio yet): also a barge-in.
  state = reduce(state, server({ type: "response.created", response: { id: "r2" } }), 6);
  state = reduce(state, server({ type: "response.done", response: { id: "r2", status: "cancelled", status_details: { reason: "turn_detected" }, output: [] } }), 7);
  assert.equal(state.interruptions, 2);
});

test("usage accumulates per response; tool-only responses keep the body thinking for the continuation", () => {
  let state = connected();
  const usage = { total_tokens: 10, input_tokens: 6, output_tokens: 4, input_token_details: { audio_tokens: 6 }, output_token_details: { audio_tokens: 4 } };
  state = reduce(state, server({ type: "response.created", response: { id: "r1" } }), 1);
  state = reduce(state, server({ type: "response.done", response: { id: "r1", status: "completed", usage,
    output: [{ type: "function_call", call_id: "c", name: "show_clock", arguments: "{}" }] } }), 2);
  assert.equal(state.responseActive, false);
  assert.equal(presenceHints(state, 3).awaitingResponse, true);
  state = reduce(state, server({ type: "response.created", response: { id: "r2" } }), 4);
  state = reduce(state, server({ type: "response.done", response: { id: "r2", status: "completed", usage, output: [{ type: "message" }] } }), 5);
  assert.equal(state.usage.totalTokens, 20);
  assert.equal(state.usage.outputAudioTokens, 8);
  assert.equal(state.responses, 2);
});

test("losing the connection clears every conversational flag", () => {
  let state = connected();
  for (const event of [
    { type: "input_audio_buffer.speech_started" }, { type: "response.created", response: { id: "r" } }, { type: "output_audio_buffer.started" },
  ]) state = reduce(state, server(event), 1);
  state = reduce(state, { type: "tool.started" }, 1);
  state = reduce(state, { type: "connection", state: "reconnecting", error: "data-channel-closed" }, 2);
  assert.deepEqual([state.userSpeaking, state.responseActive, state.audioActive, state.toolsActive], [false, false, false, 0]);
  assert.equal(presenceHints(state, 2).live, false);
  assert.equal(sessionPhase(state, 2), "reconnecting");
  assert.equal(state.error, "data-channel-closed");
});

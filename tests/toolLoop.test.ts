import test from "node:test";
import assert from "node:assert/strict";
import { ToolCallLoop, type ToolRunner } from "../src/realtime/conversation";
import { parseServerEvent, type ClientEvent } from "../src/realtime/events";
import type { ToolExecution } from "../src/realtime/tools/executor";

const settle = () => new Promise(resolve => setImmediate(resolve));
const server = (value: unknown) => parseServerEvent(JSON.stringify(value));

function harness({ canContinue = true, result = { ok: true, status: "displayed" } as ToolExecution["result"] } = {}) {
  const sent: ClientEvent[] = [];
  const calls: { name: string; args: string }[] = [];
  const pending: ((value: ToolExecution) => void)[] = [];
  let deferred = false;
  const runner: ToolRunner = {
    execute: (name, args) => {
      calls.push({ name, args });
      const execution = { name, action: null, result, ms: 1 };
      if (deferred) return new Promise(resolve => pending.push(() => resolve(execution)));
      return Promise.resolve(execution);
    },
  };
  const host = { send: (event: ClientEvent) => { sent.push(event); return true; }, canContinue: () => canContinue, started: 0, finished: 0 };
  const loop = new ToolCallLoop(runner, {
    send: host.send, canContinue: host.canContinue,
    onToolStarted: () => host.started++, onToolFinished: () => host.finished++,
  });
  return { loop, sent, calls, host, pending, defer: () => { deferred = true; } };
}

const done = (id: string, output: unknown[], status = "completed", reason?: string) =>
  server({ type: "response.done", response: { id, status, status_details: reason ? { reason } : undefined, output } });
const call = (name: string, args: string, callId = "call_1", responseId = "resp_1") =>
  server({ type: "response.function_call_arguments.done", response_id: responseId, call_id: callId, item_id: `item_${callId}`, name, arguments: args, output_index: 0 });

test("arguments are assembled from deltas, and the final .done arguments win", () => {
  const h = harness();
  for (const delta of ["{\"per", "son\":\"Nikola", " Tesla\"}"]) {
    h.loop.handle(server({ type: "response.function_call_arguments.delta", response_id: "resp_1", call_id: "call_1", item_id: "i", delta, output_index: 0 }));
  }
  assert.equal(h.loop.assembled("call_1"), "{\"person\":\"Nikola Tesla\"}");
  h.loop.handle(call("show_portrait", "{\"person\":\"Nikola Tesla\"}"));
  assert.deepEqual(h.calls, [{ name: "show_portrait", args: "{\"person\":\"Nikola Tesla\"}" }]);
  assert.equal(h.loop.assembled("call_1"), "", "assembly state is released once the call runs");
});

test("a function call executes locally and returns function_call_output to the session", async () => {
  const h = harness();
  h.loop.handle(call("show_clock", "{}"));
  await settle();
  assert.deepEqual(h.sent[0], {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true,\"status\":\"displayed\"}" },
  });
  assert.equal(h.host.started, 1);
  assert.equal(h.host.finished, 1);
  assert.equal(h.loop.last?.result?.status, "displayed");
});

test("a tool-only response is continued with response.create so the model can speak", async () => {
  const h = harness();
  h.loop.handle(call("show_clock", "{}"));
  h.loop.handle(done("resp_1", [{ type: "function_call", call_id: "call_1", name: "show_clock", arguments: "{}" }]));
  await settle();
  assert.deepEqual(h.sent.map(event => event.type), ["conversation.item.create", "response.create"]);
});

test("the continuation waits for slow tools (e.g. a portrait download) to report first", async () => {
  const h = harness();
  h.defer();
  h.loop.handle(call("show_portrait", "{\"person\":\"Nikola Tesla\"}"));
  h.loop.handle(done("resp_1", [{ type: "function_call", call_id: "call_1", name: "show_portrait", arguments: "" }]));
  await settle();
  assert.equal(h.sent.length, 0, "nothing is sent before the result exists");
  h.pending[0]({} as ToolExecution);
  await settle();
  assert.deepEqual(h.sent.map(event => event.type), ["conversation.item.create", "response.create"]);
});

test("a response that already spoke is not continued: visuals accompany speech silently", async () => {
  const h = harness();
  h.loop.handle(call("show_portrait", "{\"person\":\"Nikola Tesla\"}"));
  h.loop.handle(done("resp_1", [{ type: "message" }, { type: "function_call", call_id: "call_1", name: "show_portrait", arguments: "" }]));
  await settle();
  assert.deepEqual(h.sent.map(event => event.type), ["conversation.item.create"]);
});

test("barge-in: a cancelled response, or a user already speaking, gets no continuation", async () => {
  const cancelled = harness();
  cancelled.loop.handle(call("show_clock", "{}"));
  cancelled.loop.handle(done("resp_1", [], "cancelled", "turn_detected"));
  await settle();
  assert.deepEqual(cancelled.sent.map(event => event.type), ["conversation.item.create"]);
  const speaking = harness({ canContinue: false });
  speaking.loop.handle(call("show_clock", "{}"));
  speaking.loop.handle(done("resp_1", []));
  await settle();
  assert.deepEqual(speaking.sent.map(event => event.type), ["conversation.item.create"]);
});

test("each call runs once: response.done is only a fallback for missed .done events", async () => {
  const h = harness();
  h.loop.handle(call("show_text", "{\"value\":\"Hi\"}", "call_a"));
  h.loop.handle(done("resp_1", [
    { type: "message" },
    { type: "function_call", call_id: "call_a", name: "show_text", arguments: "{\"value\":\"Hi\"}" },
    { type: "function_call", call_id: "call_b", name: "show_symbol", arguments: "{\"symbol\":\"star\"}" },
  ]));
  await settle();
  assert.deepEqual(h.calls.map(entry => entry.name), ["show_text", "show_symbol"]);
});

test("invalid tool calls still receive an error output, so the model is never left waiting", async () => {
  const h = harness({ result: { ok: false, status: "invalid-arguments" } });
  h.loop.handle(call("show_text", "{\"value\":\"<script>\"}"));
  h.loop.handle(done("resp_1", []));
  await settle();
  assert.equal(h.sent[0].type, "conversation.item.create");
  assert.match((h.sent[0] as Extract<ClientEvent, { type: "conversation.item.create" }>).item.output, /invalid-arguments/);
  assert.equal(h.sent[1].type, "response.create", "the model continues without the visual");
});

test("results from a previous session are dropped after reset", async () => {
  const h = harness();
  h.defer();
  h.loop.handle(call("show_clock", "{}"));
  h.loop.reset();
  h.pending[0]({} as ToolExecution);
  await settle();
  assert.deepEqual(h.sent, []);
  assert.equal(h.host.finished, 0);
});

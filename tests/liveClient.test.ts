import test from "node:test";
import assert from "node:assert/strict";
import { LiveClient, type LiveEnvironment, type LivePeerLike, type LiveSessionAnswer } from "../src/live/client";
import { LiveDelegationLoop } from "../src/live/delegation";
import { parseLiveEvent, type LiveClientEvent, type LiveEvent } from "../src/live/events";
import { initialLiveState, liveHints, liveTiming, reduceLive } from "../src/live/state";
import type { ToolExecution, ToolRunner } from "../src/voice/tools/executor";
import type { ChannelLike } from "../src/voice/webrtc";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

class FakeChannel implements ChannelLike {
  readyState = "connecting";
  sent: LiveClientEvent[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = "closed"; }
  open() { this.readyState = "open"; this.onopen?.({} as Event); }
  drop() { this.readyState = "closed"; this.onclose?.({} as Event); }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent); }
}

class FakePeer implements LivePeerLike {
  connectionState = "new";
  iceGatheringState = "gathering";
  localDescription: { sdp?: string } | null = null;
  tracks: MediaStreamTrack[] = [];
  channels: FakeChannel[] = [];
  remote?: { sdp: string; type: "answer" };
  closed = false;
  ontrack: LivePeerLike["ontrack"] = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  onicegatheringstatechange: ((event: Event) => void) | null = null;
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  createDataChannel(label: string) { assert.equal(label, "oai-events"); const channel = new FakeChannel(); this.channels.push(channel); return channel; }
  async createOffer() { return { type: "offer", sdp: "v=0\r\noffer" }; }
  async setLocalDescription(description: { sdp?: string }) {
    this.localDescription = description;
    // ICE gathering finishes a moment later and adds candidates to the local description.
    setImmediate(() => { this.iceGatheringState = "complete"; this.localDescription = { sdp: "v=0\r\noffer\r\na=candidate:1" }; this.onicegatheringstatechange?.({} as Event); });
  }
  async setRemoteDescription(description: { sdp: string; type: "answer" }) { this.remote = description; }
  close() { this.closed = true; this.connectionState = "closed"; }
}

const answer: LiveSessionAnswer = { sdp: "v=0\r\nanswer", sessionId: "live_123", model: "gpt-live-1", backendModel: "gpt-5.6-terra", voice: "marin" };

function harness(runner: ToolRunner = { execute: async name => ({ name, action: null, result: { ok: true, status: "displayed" }, ms: 3 }) }) {
  const peers: FakePeer[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let clock = 0, timerId = 0;
  const offers: string[] = [];
  const environment: LiveEnvironment = {
    createPeer: () => { const peer = new FakePeer(); peers.push(peer); return peer; },
    createSession: async offer => { offers.push(offer); return answer; },
    now: () => clock,
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { at: clock + ms, callback }); return id; },
    clearTimer: id => { timers.delete(id as number); },
  };
  const advance = async (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.callback(); }
    }
    await settle();
  };
  const events: LiveEvent[] = [], streams: (MediaStream | null)[] = [], states: string[] = [];
  const client = new LiveClient(runner, environment, {
    onEvent: event => events.push(event),
    onRemoteStream: stream => streams.push(stream),
    onState: state => { if (states[states.length - 1] !== state.connection) states.push(state.connection); },
  });
  const track = { kind: "audio", readyState: "live" } as MediaStreamTrack;
  const microphone = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const latest = () => peers[peers.length - 1];
  const channel = () => latest().channels[0];
  const started = async () => {
    client.connect(microphone);
    await settle();
    channel().open();
    channel().receive({ type: "session.started", session: { id: "live_123", model: "gpt-live-1", status: "active", audio: { output: { voice: "marin" } } } });
  };
  return { client, peers, latest, channel, offers, advance, events, streams, states, microphone, track, timers, started, clock: () => clock };
}

test("live events: only current GPT-Live names are recognized; Realtime names are not", () => {
  assert.deepEqual(parseLiveEvent({ type: "session.started", session: { id: "live_1", model: "gpt-live-1", audio: { output: { voice: "marin" } } } }),
    { type: "session.started", sessionId: "live_1", model: "gpt-live-1", voice: "marin", expiresAt: undefined });
  assert.deepEqual(parseLiveEvent({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "del_1", type: "delegation", target: "responses", response_id: "resp_1" } }),
    { type: "delegation.created", delegationId: "del_1", target: "responses", responseId: "resp_1", offsetMs: 900 });
  assert.deepEqual(parseLiveEvent({ type: "response.event", delegation_id: "del_1", event: { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "show_clock", arguments: "{}" } } }),
    { type: "backend.function_call", delegationId: "del_1", call: { callId: "call_1", itemId: "fc_1", name: "show_clock", arguments: "{}" } });
  assert.equal(parseLiveEvent({ type: "response.event", delegation_id: "del_1", event: { type: "response.function_call_arguments.done", arguments: "{}" } }).type, "backend.other",
    "an arguments-done event alone does not identify a call");
  assert.deepEqual(parseLiveEvent({ type: "response.event", delegation_id: "del_1", event: { type: "response.completed", response: { id: "resp_1", output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 2 } } } } }),
    { type: "backend.response.finished", delegationId: "del_1", responseId: "resp_1", status: "completed", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedTokens: 2 } });
  assert.deepEqual(parseLiveEvent({ type: "session.usage.updated", usage: { seconds: 32.5 }, context_window: { usage_ratio: 0.12 } }), { type: "usage", seconds: 32.5, contextRatio: 0.12 });
  assert.deepEqual(parseLiveEvent({ type: "session.closed", reason: "close_requested", usage: { seconds: 40 } }), { type: "session.closed", reason: "close_requested", seconds: 40 });
  assert.equal(parseLiveEvent({ type: "session.input_transcript.delta", delta: "你好", start_ms: 1, end_ms: 2 }).type, "transcript.user");
  assert.equal(parseLiveEvent({ type: "error", error: { code: "immutable_field_update", message: "x", client_event_id: "e1" } }).type, "error");
  for (const realtime of ["response.done", "input_audio_buffer.speech_started", "output_audio_buffer.cleared", "response.function_call_arguments.done"]) {
    assert.deepEqual(parseLiveEvent({ type: realtime }), { type: "ignored", name: realtime });
  }
  assert.deepEqual(parseLiveEvent("{not json"), { type: "ignored", name: "malformed" });
});

test("connect: complete (non-trickle) offer to SCF's server, answer applied, connected only on session.started", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  assert.equal(h.client.connection, "connecting");
  await settle();
  assert.deepEqual(h.latest().tracks, [h.track], "the same microphone track goes to GPT-Live");
  assert.deepEqual(h.offers, ["v=0\r\noffer\r\na=candidate:1"], "the offer is sent after ICE gathering, with candidates");
  assert.deepEqual(h.latest().remote, { type: "answer", sdp: "v=0\r\nanswer" });
  h.channel().open();
  assert.equal(h.client.connection, "connecting", "an open data channel is not yet a started session");
  h.channel().receive({ type: "session.started", session: { id: "live_123", model: "gpt-live-1" } });
  assert.equal(h.client.connection, "connected");
  assert.equal(h.client.state.sessionId, "live_123");
  assert.equal(h.client.state.backendModel, "gpt-5.6-terra");
  assert.equal(h.client.connectMs, 0);
  assert.equal(h.channel().sent.length, 0, "the client never sends session.start");
  const stream = {} as MediaStream;
  h.latest().ontrack?.({ track: {} as MediaStreamTrack, streams: [stream] });
  assert.equal(h.streams[0], stream, "the remote assistant track feeds AssistantAudio exactly like Realtime's");
});

test("delegation: function call from the nested finished item → shared executor → response.item.create → response.create", async () => {
  const calls: [string, string][] = [];
  const h = harness({ execute: async (name, args) => { calls.push([name, args]); return { name, action: null, result: { ok: true, status: "displayed", shown: "15:42" }, ms: 5 }; } });
  await h.started();
  const ch = h.channel();
  ch.receive({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "del_1", type: "delegation", target: "responses" } });
  assert.equal(h.client.hints(0).awaitingResponse, true, "an active delegation with no audio lets the body think");
  ch.receive({ type: "response.event", delegation_id: "del_1", event: { type: "response.created", response: { id: "resp_1", output: [] } } });
  ch.receive({ type: "response.event", delegation_id: "del_1", event: { type: "response.function_call_arguments.done", arguments: "{}" } });
  assert.deepEqual(calls, [], "nothing runs on the arguments-done event");
  ch.receive({ type: "response.event", delegation_id: "del_1", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "show_clock", arguments: "{}" } } });
  ch.receive({ type: "response.event", delegation_id: "del_1", event: { type: "response.completed", response: { id: "resp_1", output: [] } } });
  await settle();
  assert.deepEqual(calls, [["show_clock", "{}"]]);
  assert.deepEqual(ch.sent.map(event => ({ ...event, event_id: undefined })), [
    { type: "response.item.create", event_id: undefined, item: { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true,\"status\":\"displayed\",\"shown\":\"15:42\"}" } },
    { type: "response.create", event_id: undefined },
  ]);
  assert.ok(ch.sent.every(event => typeof event.event_id === "string"));
  assert.ok(!ch.sent.some(event => (event as { type: string }).type === "conversation.item.create"), "no Realtime protocol on the Live channel");
  // The continuation is a new backend response for the same delegation; with no calls it ends the delegation.
  ch.receive({ type: "response.event", delegation_id: "del_1", event: { type: "response.created", response: { id: "resp_2" } } });
  assert.equal(h.client.delegation.active, 1);
  ch.receive({ type: "response.event", delegation_id: "del_1", event: { type: "response.completed", response: { id: "resp_2", output: [], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } } });
  assert.equal(h.client.delegation.active, 0);
  assert.equal(h.client.state.delegationsActive, 0);
  assert.equal(h.client.state.backendUsage.totalTokens, 8);
  assert.deepEqual({ ...h.client.delegation.stats, delegationToCallMs: typeof h.client.delegation.stats.delegationToCallMs },
    { delegations: 1, functionCalls: 1, continuations: 1, backendResponses: 2, delegationToCallMs: "number" });
  assert.equal(h.client.delegation.last?.name, "show_clock");
});

test("delegation: results for every call before continuing; duplicates run once; failed responses are not continued", async () => {
  const pending: ((value: ToolExecution) => void)[] = [];
  const runner: ToolRunner = { execute: name => new Promise(resolve => pending.push(value => resolve({ ...value, name }))) };
  const sent: LiveClientEvent[] = [];
  let finished = 0;
  const loop = new LiveDelegationLoop(runner, { send: event => { sent.push(event); return true; }, canContinue: () => true, onDelegationFinished: () => finished++ });
  loop.handle({ type: "delegation.created", delegationId: "d", target: "responses" });
  loop.handle({ type: "backend.response.started", delegationId: "d", responseId: "r" });
  const call = { callId: "c1", name: "show_text", arguments: "{\"value\":\"Hi\"}" };
  loop.handle({ type: "backend.function_call", delegationId: "d", call });
  loop.handle({ type: "backend.function_call", delegationId: "d", call });
  loop.handle({ type: "backend.response.finished", delegationId: "d", responseId: "r", status: "completed" });
  assert.equal(pending.length, 1, "a call id runs once");
  assert.equal(sent.length, 0, "no continuation before the result exists");
  pending[0]({ name: "", action: null, result: { ok: true, status: "displayed" }, ms: 1 });
  await settle();
  assert.deepEqual(sent.map(event => event.type), ["response.item.create", "response.create"]);

  const failedSent: LiveClientEvent[] = [];
  const failedLoop = new LiveDelegationLoop({ execute: async name => ({ name, action: null, result: { ok: true, status: "displayed" }, ms: 0 }) },
    { send: event => { failedSent.push(event); return true; }, canContinue: () => true });
  failedLoop.handle({ type: "delegation.created", delegationId: "d", target: "responses" });
  failedLoop.handle({ type: "backend.response.started", delegationId: "d", responseId: "r" });
  failedLoop.handle({ type: "backend.function_call", delegationId: "d", call });
  failedLoop.handle({ type: "backend.response.finished", delegationId: "d", responseId: "r", status: "failed" });
  await settle();
  assert.deepEqual(failedSent.map(event => event.type), ["response.item.create"], "the result is returned, but a failed response is not continued");
  assert.equal(failedLoop.active, 0);

  const closing = new LiveDelegationLoop({ execute: async name => ({ name, action: null, result: { ok: true, status: "displayed" }, ms: 0 }) },
    { send: () => true, canContinue: () => false });
  closing.handle({ type: "delegation.created", delegationId: "d", target: "responses" });
  closing.handle({ type: "backend.response.started", delegationId: "d", responseId: "r" });
  closing.handle({ type: "backend.function_call", delegationId: "d", call });
  closing.handle({ type: "backend.response.finished", delegationId: "d", responseId: "r", status: "completed" });
  await settle();
  assert.equal(closing.stats.continuations, 0, "a closing session is not continued");
  loop.handle({ type: "delegation.created", delegationId: "client-owned", target: "client" });
  assert.equal(loop.stats.delegations, 1, "client delegations are not SCF's (Responses delegation is configured)");
  assert.equal(finished, 0, "a continued delegation stays active until its continuation finishes");
  assert.equal(loop.active, 1);
});

test("a late tool result from a previous session is dropped", async () => {
  let resolve!: (value: ToolExecution) => void;
  const h = harness({ execute: () => new Promise(r => { resolve = r; }) });
  await h.started();
  const old = h.channel();
  old.receive({ type: "session.delegation.created", delegation: { id: "d", type: "delegation", target: "responses" } });
  old.receive({ type: "response.event", delegation_id: "d", event: { type: "response.created", response: { id: "r" } } });
  old.receive({ type: "response.event", delegation_id: "d", event: { type: "response.output_item.done", item: { type: "function_call", call_id: "c", name: "show_clock", arguments: "{}" } } });
  h.client.disconnect();
  resolve({ name: "show_clock", action: null, result: { ok: true, status: "displayed" }, ms: 0 });
  await settle();
  assert.ok(!old.sent.some(event => event.type === "response.item.create"));
});

test("hints: full duplex; user transcript = listening; a reply is expected briefly; stale delegations expire", () => {
  let s = reduceLive(initialLiveState(), { type: "connection", state: "connected" }, 0);
  assert.deepEqual(liveHints(s, 0), { live: true, userSpeaking: false, awaitingResponse: false, toolActive: false, fullDuplex: true });
  s = reduceLive(s, { type: "transcript.user", text: "What time" }, 1000);
  assert.equal(liveHints(s, 1100).userSpeaking, true);
  assert.equal(liveHints(s, 1000 + liveTiming.userHoldMs + 100).awaitingResponse, true, "after the user stops, a reply is expected");
  assert.equal(liveHints(s, 1000 + liveTiming.userHoldMs + liveTiming.replyWindowMs + 100).awaitingResponse, false, "…but not forever");
  const answered = reduceLive(s, { type: "transcript.assistant", text: "It's" }, 2000);
  assert.equal(liveHints(answered, 2100).awaitingResponse, false, "the assistant already replied");
  s = reduceLive(s, { type: "delegation.started" }, 3000);
  assert.equal(liveHints(s, 3000 + liveTiming.delegationStaleMs - 1).awaitingResponse, true);
  assert.equal(liveHints(s, 3000 + liveTiming.delegationStaleMs + 1).awaitingResponse, false, "a lost terminal event cannot keep the body thinking");
  const dropped = reduceLive(s, { type: "connection", state: "reconnecting" }, 4000);
  assert.deepEqual(liveHints(dropped, 4000), { live: false, userSpeaking: false, awaitingResponse: false, toolActive: false, fullDuplex: true });
});

test("graceful close: session.close is sent and final usage read from session.closed; the state changes at once", async () => {
  const h = harness();
  await h.started();
  const channel = h.channel(), peer = h.latest();
  channel.receive({ type: "session.usage.updated", usage: { seconds: 12 } });
  h.client.disconnect();
  assert.equal(h.client.connection, "disconnected", "the body does not wait for finalization");
  assert.deepEqual(channel.sent.map(event => event.type), ["session.close"]);
  assert.equal(peer.closed, false, "the peer stays open until session.closed");
  assert.equal(h.streams[h.streams.length - 1], null, "assistant audio is detached immediately");
  channel.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 15 } });
  assert.equal(peer.closed, true);
  assert.deepEqual(h.client.lastClose, { sessionId: "live_123", reason: "close_requested", seconds: 15, confirmed: true });

  const g = harness();
  await g.started();
  const quiet = g.latest();
  g.client.disconnect("ended");
  await g.advance(3000);
  assert.equal(quiet.closed, true, "without session.closed the peer is released after a timeout");
  assert.equal(g.client.lastClose?.confirmed, false);
});

test("drops reconnect with backoff; a safety close is final; errors from the server are not retried", async () => {
  const h = harness();
  await h.started();
  h.channel().receive({ type: "session.closed", reason: "connection_lost" });
  assert.equal(h.client.connection, "reconnecting");
  await h.advance(1000);
  await settle();
  assert.equal(h.peers.length, 2, "a new session is created");

  const c = harness();
  await c.started();
  c.channel().receive({ type: "session.closed", reason: "content" });
  assert.equal(c.client.connection, "error");
  assert.equal(c.client.state.error, "session-content");

  const peers: FakePeer[] = [];
  const failing = new LiveClient({ execute: async name => ({ name, action: null, result: { ok: true, status: "displayed" }, ms: 0 }) }, {
    createPeer: () => { const peer = new FakePeer(); peer.iceGatheringState = "complete"; peers.push(peer); return peer; },
    createSession: async () => { const { LiveConnectError } = await import("../src/live/client"); throw new LiveConnectError("not-configured", false); },
    now: () => 0, setTimer: () => 0, clearTimer: () => {},
  });
  failing.connect(c.microphone);
  await settle();
  assert.equal(failing.connection, "error");
  assert.equal(failing.state.error, "not-configured");
});

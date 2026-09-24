import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeClient, RealtimeConnectError, type ChannelLike, type PeerLike, type RealtimeEnvironment, type RealtimeToken } from "../src/realtime/client";
import type { RealtimeEvent } from "../src/realtime/events";
import type { ToolRunner } from "../src/realtime/conversation";

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

class FakeChannel implements ChannelLike {
  readyState = "connecting";
  sent: unknown[] = [];
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

class FakePeer implements PeerLike {
  connectionState = "new";
  tracks: MediaStreamTrack[] = [];
  channels: FakeChannel[] = [];
  remote?: { sdp: string; type: "answer" };
  closed = false;
  ontrack: PeerLike["ontrack"] = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  createDataChannel(label: string) { assert.equal(label, "oai-events"); const channel = new FakeChannel(); this.channels.push(channel); return channel; }
  async createOffer() { return { type: "offer", sdp: "v=0 offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription(description: { sdp: string; type: "answer" }) { this.remote = description; }
  close() { this.closed = true; this.connectionState = "closed"; }
  setState(state: string) { this.connectionState = state; this.onconnectionstatechange?.({} as Event); }
}

function harness(options: { token?: () => Promise<RealtimeToken> } = {}) {
  const peers: FakePeer[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let clock = 0, timerId = 0;
  const offers: { sdp: string; token: string }[] = [];
  const environment: RealtimeEnvironment = {
    fetchToken: options.token ?? (async () => ({ value: "ek_test", model: "gpt-realtime-2.1", voice: "marin" })),
    createPeer: () => { const peer = new FakePeer(); peers.push(peer); return peer; },
    exchangeSdp: async (offer, token) => { offers.push({ sdp: offer, token: token.value }); return "v=0 answer"; },
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
  const runner: ToolRunner = { execute: async name => ({ name, action: null, result: { ok: true, status: "displayed" }, ms: 0 }) };
  const events: RealtimeEvent[] = [], streams: (MediaStream | null)[] = [], states: string[] = [];
  const client = new RealtimeClient(runner, environment, {
    onEvent: event => events.push(event),
    onRemoteStream: stream => streams.push(stream),
    onState: state => { if (states[states.length - 1] !== state.connection) states.push(state.connection); },
  });
  const track = { kind: "audio", readyState: "live" } as MediaStreamTrack;
  const microphone = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const latest = () => peers[peers.length - 1];
  const channel = () => latest().channels[0];
  return { client, peers, latest, channel, offers, advance, events, streams, states, microphone, track, timers };
}

test("connect: token → peer with the microphone track → SDP offer/answer → data channel open", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  assert.equal(h.client.connection, "connecting");
  await settle();
  assert.deepEqual(h.latest().tracks, [h.track], "the same microphone track goes to OpenAI");
  assert.deepEqual(h.offers, [{ sdp: "v=0 offer", token: "ek_test" }], "only the ephemeral secret is used in the browser");
  assert.deepEqual(h.latest().remote, { type: "answer", sdp: "v=0 answer" });
  h.channel().open();
  assert.equal(h.client.connection, "connected");
  assert.deepEqual(h.client.token, { model: "gpt-realtime-2.1", voice: "marin" });
  const stream = {} as MediaStream;
  h.latest().ontrack?.({ track: {} as MediaStreamTrack, streams: [stream] });
  assert.equal(h.streams[0], stream, "the remote assistant track is handed to playback and analysis");
});

test("connect is idempotent: a second call never creates a second session", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  h.client.connect(h.microphone);
  await settle();
  h.channel().open();
  h.client.connect(h.microphone);
  await settle();
  assert.equal(h.peers.length, 1);
});

test("server events update session state and the Presence hints", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  h.channel().open();
  h.channel().receive({ type: "session.created", session: { id: "sess_1", model: "gpt-realtime-2.1" } });
  h.channel().receive({ type: "input_audio_buffer.speech_started", item_id: "a" });
  assert.equal(h.client.hints(0).userSpeaking, true);
  h.channel().receive({ type: "input_audio_buffer.speech_stopped", item_id: "a" });
  h.channel().receive({ type: "response.created", response: { id: "r1" } });
  assert.deepEqual(h.client.hints(0), { live: true, userSpeaking: false, awaitingResponse: true, toolActive: false });
  h.channel().receive({ type: "output_audio_buffer.started", response_id: "r1" });
  assert.equal(h.client.hints(0).awaitingResponse, false, "speaking comes from the real audio, not thinking");
  h.channel().receive({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Hello there." });
  assert.equal(h.client.state.sessionId, "sess_1");
  assert.deepEqual(h.client.transcripts.map(entry => entry.text), ["Hello there."]);
  assert.ok(h.events.some(event => event.type === "audio.started"));
});

test("tool call over the data channel: executed locally, output sent back, tool-only response continued", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  h.channel().open();
  h.channel().receive({ type: "response.created", response: { id: "r1" } });
  h.channel().receive({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "call_1", item_id: "i1", name: "show_clock", arguments: "{}", output_index: 0 });
  h.channel().receive({ type: "response.done", response: { id: "r1", status: "completed", output: [{ type: "function_call", call_id: "call_1", name: "show_clock", arguments: "{}" }] } });
  await settle();
  assert.deepEqual(h.channel().sent, [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true,\"status\":\"displayed\"}" } },
    { type: "response.create" },
  ]);
  assert.equal(h.client.tools.last?.name, "show_clock");
});

test("interruption: cleared audio and a cancelled response leave the session listening", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  h.channel().open();
  h.channel().receive({ type: "response.created", response: { id: "r1" } });
  h.channel().receive({ type: "output_audio_buffer.started", response_id: "r1" });
  h.channel().receive({ type: "input_audio_buffer.speech_started", item_id: "b" });
  h.channel().receive({ type: "output_audio_buffer.cleared", response_id: "r1" });
  h.channel().receive({ type: "response.done", response: { id: "r1", status: "cancelled", status_details: { reason: "turn_detected" }, output: [] } });
  assert.equal(h.client.state.interruptions, 1);
  assert.deepEqual(h.client.hints(0), { live: true, userSpeaking: true, awaitingResponse: false, toolActive: false });
  assert.ok(h.events.some(event => event.type === "audio.cleared"), "the Presence is told to stop speaking at once");
  assert.deepEqual(h.channel().sent, [], "the client does not fight the server's own barge-in handling");
});

test("disconnect: closes peer and channel, clears the remote stream, no reconnect", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  const channel = h.channel();
  channel.open();
  h.latest().ontrack?.({ track: {} as MediaStreamTrack, streams: [{} as MediaStream] });
  h.client.disconnect();
  assert.equal(h.client.connection, "disconnected");
  assert.equal(h.latest().closed, true);
  assert.equal(channel.closed, true);
  assert.equal(h.streams[h.streams.length - 1], null);
  assert.equal(h.client.send({ type: "response.create" }), false);
  await h.advance(60_000);
  assert.equal(h.peers.length, 1);
});

test("reconnect: an unexpected drop cleans up and retries with bounded backoff", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  h.channel().open();
  h.channel().receive({ type: "output_audio_buffer.started", response_id: "r1" });
  h.channel().drop();
  assert.equal(h.client.connection, "reconnecting");
  assert.equal(h.client.state.audioActive, false, "stale speaking state is cleared");
  assert.equal(h.peers[0].closed, true);
  await h.advance(1000);
  assert.equal(h.peers.length, 2, "one new peer after the first backoff");
  h.channel().open();
  assert.equal(h.client.connection, "connected");
  assert.deepEqual(h.states, ["connecting", "connected", "reconnecting", "connected"]);
});

test("reconnect gives up after the bounded attempts and reports an error", async () => {
  const h = harness({ token: async () => { throw new RealtimeConnectError("token-unreachable", true); } });
  h.client.connect(h.microphone);
  await settle();
  assert.equal(h.client.connection, "reconnecting");
  for (const delay of [1000, 3000, 8000]) await h.advance(delay);
  assert.equal(h.client.connection, "error");
  assert.equal(h.client.state.error, "token-unreachable");
  await h.advance(60_000);
  assert.equal(h.client.connection, "error", "no further attempts");
});

test("configuration errors are not retried", async () => {
  const h = harness({ token: async () => { throw new RealtimeConnectError("not-configured", false); } });
  h.client.connect(h.microphone);
  await settle();
  assert.equal(h.client.connection, "error");
  assert.equal(h.client.state.error, "not-configured");
  assert.equal(h.peers.length, 0);
  // A user retry after fixing the configuration starts cleanly.
  h.client.connect(h.microphone);
  assert.equal(h.client.connection, "connecting");
});

test("a briefly disconnected peer may recover; a lasting one is treated as dropped", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  h.channel().open();
  h.latest().setState("disconnected");
  await h.advance(2000);
  h.latest().setState("connected");
  await h.advance(5000);
  assert.equal(h.client.connection, "connected");
  h.latest().setState("disconnected");
  await h.advance(4000);
  assert.equal(h.client.connection, "reconnecting");
});

test("late callbacks from a replaced peer are ignored", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  const old = h.channel();
  old.open();
  old.drop();
  await h.advance(1000);
  h.channel().open();
  old.receive({ type: "input_audio_buffer.speech_started" });
  old.drop();
  assert.equal(h.client.connection, "connected");
  assert.equal(h.client.state.userSpeaking, false);
  assert.equal(h.peers.length, 2);
});

test("a session that never finishes connecting times out into a reconnect", async () => {
  const h = harness();
  h.client.connect(h.microphone);
  await settle();
  await h.advance(20_000);
  assert.equal(h.client.connection, "reconnecting");
  assert.equal(h.client.state.error, "connect-timeout");
});

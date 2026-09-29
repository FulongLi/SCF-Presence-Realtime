import { speakInstructions } from "../aion/guidance";
import type { ConversationHints } from "../presence/PresenceEngine";
import type { ConnectionState, Transcript, VoiceClient } from "../voice/client";
import { EVENTS_CHANNEL, type ChannelLike, type PeerLike } from "../voice/webrtc";
import { ToolCallLoop, type ToolRunner } from "./conversation";
import { parseServerEvent, type ClientEvent, type RealtimeEvent } from "./events";
import { initialState, presenceHints, reduce, type RealtimePresenceState, type StateEvent } from "./state";

export type { ChannelLike, PeerLike, Transcript };

/** What the SCF server returns from POST /api/realtime/token. Never contains the standard API key. */
export interface RealtimeToken { value: string; expiresAt?: number; model: string; voice: string }

/** A connection failure. `retryable` separates transient network trouble from configuration errors. */
export class RealtimeConnectError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); this.name = "RealtimeConnectError"; }
}

export interface RealtimeEnvironment {
  fetchToken(signal: AbortSignal): Promise<RealtimeToken>;
  createPeer(): PeerLike;
  /** Posts the SDP offer to OpenAI with the ephemeral key; resolves to the SDP answer. */
  exchangeSdp(offer: string, token: RealtimeToken, signal: AbortSignal): Promise<string>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export interface RealtimeCallbacks {
  onState?(state: RealtimePresenceState): void;
  /** Every normalized server event (after state and tools have seen it). */
  onEvent?(event: RealtimeEvent): void;
  /** The remote assistant audio stream, or null when the session is gone. */
  onRemoteStream?(stream: MediaStream | null): void;
}

export const reconnectDefaults = {
  /** Delays before each reconnect attempt; its length bounds the number of attempts. */
  backoffMs: [1000, 3000, 8000],
  /** A peer in "disconnected" may recover by itself; after this grace it is treated as dropped. */
  disconnectGraceMs: 4000,
  /** Connecting (token, SDP, ICE, data channel) must finish within this time. */
  connectTimeoutMs: 20000,
};

/**
 * One browser Realtime session over WebRTC.
 *
 *   microphone track ──► RTCPeerConnection ──► OpenAI Realtime ──► remote audio track (the voice)
 *                        data channel "oai-events" ◄──► server/client events (turns, responses, tools)
 *
 * At most one peer connection exists at a time: every (re)connect bumps a generation counter and
 * tears down the previous peer, and late callbacks from an old generation are ignored.
 */
export class RealtimeClient implements VoiceClient {
  readonly backend = "realtime" as const;
  state: RealtimePresenceState = initialState();
  token: Pick<RealtimeToken, "model" | "voice"> | null = null;
  readonly transport = { peer: "new", channel: "closed" };
  readonly transcripts: Transcript[] = [];
  readonly tools: ToolCallLoop;
  private peer?: PeerLike;
  private channel?: ChannelLike;
  private microphone?: MediaStream;
  private generation = 0;
  private attempts = 0;
  private abort?: AbortController;
  private retryTimer?: unknown;
  private graceTimer?: unknown;
  private connectTimer?: unknown;

  constructor(
    runner: ToolRunner,
    private readonly environment: RealtimeEnvironment,
    private readonly callbacks: RealtimeCallbacks = {},
    private readonly options = reconnectDefaults,
  ) {
    this.tools = new ToolCallLoop(runner, {
      send: event => this.send(event),
      canContinue: () => this.state.connection === "connected" && !this.state.userSpeaking && !this.state.responseActive,
      onToolStarted: () => this.dispatch({ type: "tool.started" }),
      onToolFinished: () => this.dispatch({ type: "tool.finished" }),
    }, () => environment.now());
  }

  get connection(): ConnectionState { return this.state.connection; }

  /** ConversationSource for the PresenceEngine; `now` is in seconds like the engine clock. */
  hints(now: number): ConversationHints { return presenceHints(this.state, now * 1000); }

  /** A response, assistant audio or user speech is in progress. */
  busy(): boolean {
    const s = this.state;
    return s.responseActive || s.audioActive || s.userSpeaking || s.toolsActive > 0;
  }

  /** Starts a session with the page's microphone stream. A second call while active is a no-op. */
  connect(microphone: MediaStream) {
    this.microphone = microphone;
    if (this.state.connection === "connecting" || this.state.connection === "connected" || this.state.connection === "reconnecting") return;
    this.attempts = 0;
    void this.open("connecting");
  }

  /** Ends the session on purpose (user navigation, idle timeout). No reconnect follows. */
  disconnect(final: "disconnected" | "ended" = "disconnected") {
    this.generation++;
    this.teardown();
    this.dispatch({ type: "connection", state: final });
  }

  /**
   * Has the voice say a short line itself (Aion's first greeting): one response with its own instructions.
   * Not while anything else is in progress, so it never talks over the user or another reply.
   */
  speak(line: string): boolean {
    if (this.state.connection !== "connected" || this.busy()) return false;
    return this.send({ type: "response.create", response: { instructions: speakInstructions(line) } });
  }

  send(event: ClientEvent): boolean {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") return false;
    try { channel.send(JSON.stringify(event)); return true; } catch { return false; }
  }

  private async open(kind: "connecting" | "reconnecting") {
    const microphone = this.microphone;
    if (!microphone) return;
    const generation = ++this.generation;
    this.teardown();
    this.dispatch({ type: "connection", state: kind });
    const abort = new AbortController();
    this.abort = abort;
    const stale = () => generation !== this.generation;
    this.connectTimer = this.environment.setTimer(() => this.dropped(generation, new RealtimeConnectError("connect-timeout", true)), this.options.connectTimeoutMs);
    try {
      const token = await this.environment.fetchToken(abort.signal);
      if (stale()) return;
      this.token = { model: token.model, voice: token.voice };
      const peer = this.environment.createPeer();
      this.peer = peer;
      peer.ontrack = event => {
        if (stale()) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.callbacks.onRemoteStream?.(stream);
      };
      peer.onconnectionstatechange = () => this.peerState(generation, peer);
      for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
      const channel = peer.createDataChannel(EVENTS_CHANNEL);
      this.channel = channel;
      this.transport.channel = "connecting";
      channel.onopen = () => {
        if (stale()) return;
        this.transport.channel = "open";
        this.attempts = 0;
        this.environment.clearTimer(this.connectTimer);
        this.dispatch({ type: "connection", state: "connected" });
      };
      channel.onclose = () => {
        if (stale()) return;
        this.transport.channel = "closed";
        this.dropped(generation, new RealtimeConnectError("data-channel-closed", true));
      };
      channel.onmessage = event => { if (!stale()) this.receive(event.data); };
      const offer = await peer.createOffer();
      if (stale()) return;
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new RealtimeConnectError("webrtc-failed", true);
      const answer = await this.environment.exchangeSdp(offer.sdp, token, abort.signal);
      if (stale()) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (error) {
      if (stale()) return;
      this.dropped(generation, error instanceof RealtimeConnectError ? error
        : new RealtimeConnectError(error instanceof DOMException && error.name === "AbortError" ? "aborted" : "webrtc-failed", true));
    }
  }

  private peerState(generation: number, peer: PeerLike) {
    if (generation !== this.generation) return;
    const state = peer.connectionState;
    this.transport.peer = state;
    this.environment.clearTimer(this.graceTimer);
    if (state === "failed" || state === "closed") {
      this.dropped(generation, new RealtimeConnectError("webrtc-failed", true));
    } else if (state === "disconnected") {
      this.graceTimer = this.environment.setTimer(() => {
        if (peer.connectionState === "disconnected") this.dropped(generation, new RealtimeConnectError("webrtc-disconnected", true));
      }, this.options.disconnectGraceMs);
    }
  }

  /** Unexpected loss: clean up, stop stale speaking/thinking, and retry a bounded number of times. */
  private dropped(generation: number, error: RealtimeConnectError) {
    if (generation !== this.generation) return;
    this.generation++;
    this.teardown();
    const delay = this.options.backoffMs[this.attempts];
    if (error.retryable && delay !== undefined) {
      this.attempts++;
      this.dispatch({ type: "connection", state: "reconnecting", error: error.code });
      const next = this.generation;
      this.retryTimer = this.environment.setTimer(() => { if (next === this.generation) void this.open("reconnecting"); }, delay);
    } else {
      this.dispatch({ type: "connection", state: "error", error: error.code });
    }
  }

  private teardown() {
    this.abort?.abort();
    this.abort = undefined;
    for (const timer of [this.retryTimer, this.graceTimer, this.connectTimer]) this.environment.clearTimer(timer);
    this.retryTimer = this.graceTimer = this.connectTimer = undefined;
    const channel = this.channel, peer = this.peer;
    this.channel = this.peer = undefined;
    if (channel) { channel.onopen = channel.onclose = channel.onmessage = null; try { channel.close(); } catch { /* already closed */ } }
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; try { peer.close(); } catch { /* already closed */ } }
    this.transport.peer = "closed"; this.transport.channel = "closed";
    this.tools.reset();
    if (peer) this.callbacks.onRemoteStream?.(null);
  }

  private receive(data: unknown) {
    const event = parseServerEvent(data);
    this.dispatch(event);
    this.tools.handle(event);
    if (event.type === "transcript.user" || event.type === "transcript.assistant") {
      if (event.text) {
        this.transcripts.push({ role: event.type === "transcript.user" ? "user" : "assistant", text: event.text, at: this.environment.now() });
        if (this.transcripts.length > 20) this.transcripts.shift();
      }
    }
    this.callbacks.onEvent?.(event);
  }

  private dispatch(event: StateEvent) {
    const next = reduce(this.state, event, this.environment.now());
    if (next === this.state) return;
    this.state = next;
    this.callbacks.onState?.(next);
  }
}

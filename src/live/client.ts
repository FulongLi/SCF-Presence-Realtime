import type { ConversationHints } from "../presence/PresenceEngine";
import type { ConnectionState, Transcript, VoiceClient } from "../voice/client";
import type { ToolRunner } from "../voice/tools/executor";
import { EVENTS_CHANNEL, type ChannelLike, type PeerLike } from "../voice/webrtc";
import { LiveDelegationLoop } from "./delegation";
import { parseLiveEvent, type LiveClientEvent, type LiveCloseReason, type LiveEvent } from "./events";
import { initialLiveState, liveBusy, liveHints, reduceLive, type LivePresenceState, type LiveStateEvent } from "./state";

/** What the SCF server returns from POST /api/live/session. Never contains the API key. */
export interface LiveSessionAnswer { sdp: string; sessionId?: string; model: string; backendModel: string; voice: string }

/** A peer connection with the ICE-gathering surface GPT-Live's non-trickle offer needs. */
export interface LivePeerLike extends PeerLike {
  readonly iceGatheringState: string;
  readonly localDescription: { sdp?: string } | null;
  onicegatheringstatechange: ((event: Event) => void) | null;
}

export interface LiveEnvironment {
  createPeer(): LivePeerLike;
  /** Sends the SDP offer to SCF's server, which creates the Live session with OPENAI_API_KEY. */
  createSession(offer: string, signal: AbortSignal): Promise<LiveSessionAnswer>;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export interface LiveCallbacks {
  onState?(state: LivePresenceState): void;
  /** Every normalized server event (after state and delegation have seen it). */
  onEvent?(event: LiveEvent): void;
  /** The remote assistant audio stream, or null when the session is gone. */
  onRemoteStream?(stream: MediaStream | null): void;
}

/** A connection failure. `retryable` separates transient trouble from configuration errors. */
export class LiveConnectError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); this.name = "LiveConnectError"; }
}

export const liveDefaults = {
  /** Delays before each reconnect attempt; its length bounds the number of attempts. */
  backoffMs: [1000, 3000, 8000],
  /** A peer in "disconnected" may recover by itself; after this grace it is treated as dropped. */
  disconnectGraceMs: 4000,
  /** Connecting (ICE, session creation, SDP, session.started) must finish within this time. */
  connectTimeoutMs: 20000,
  /** GPT-Live takes a complete (non-trickle) offer: wait this long for ICE gathering. */
  iceGatheringMs: 4000,
  /** After session.close, wait this long for session.closed (final usage) before releasing the peer. */
  closeGraceMs: 3000,
};

/** How the last session ended, for diagnostics: `confirmed` means session.closed arrived. */
export interface LiveCloseRecord { sessionId: string | null; reason: LiveCloseReason | "unconfirmed"; seconds: number; confirmed: boolean }

/**
 * One browser GPT-Live session over WebRTC.
 *
 *   microphone track ──► RTCPeerConnection ──► GPT-Live ──► remote audio track (the voice)
 *   SDP offer ──► SCF server (OPENAI_API_KEY) ──► POST /v1/live/sessions ──► SDP answer + session id
 *   data channel "oai-events" ◄──► session, transcript and nested Responses (delegation) events
 *
 * The HTTP request starts the session: the client never sends session.start, and treats the session as
 * connected only when `session.started` arrives. As with Realtime, at most one peer connection is live;
 * a generation counter makes late callbacks from an old peer harmless.
 */
export class LiveClient implements VoiceClient {
  readonly backend = "live" as const;
  state: LivePresenceState = initialLiveState();
  readonly transport = { peer: "new", channel: "closed", ice: "new" };
  readonly transcripts: Transcript[] = [];
  readonly delegation: LiveDelegationLoop;
  /** Connect start → session.started (ms), for the most recent connection. */
  connectMs: number | null = null;
  lastClose: LiveCloseRecord | null = null;
  private peer?: LivePeerLike;
  private channel?: ChannelLike;
  private microphone?: MediaStream;
  private generation = 0;
  private attempts = 0;
  private connectStartedAt = 0;
  private abort?: AbortController;
  private retryTimer?: unknown;
  private graceTimer?: unknown;
  private connectTimer?: unknown;

  constructor(
    runner: ToolRunner,
    private readonly environment: LiveEnvironment,
    private readonly callbacks: LiveCallbacks = {},
    private readonly options = liveDefaults,
  ) {
    this.delegation = new LiveDelegationLoop(runner, {
      send: event => this.send(event),
      canContinue: () => this.state.connection === "connected",
      onDelegationStarted: () => this.dispatch({ type: "delegation.started" }),
      onDelegationFinished: (_id, status) => this.dispatch({ type: "delegation.finished", status }),
      onToolStarted: () => this.dispatch({ type: "tool.started" }),
      onToolFinished: () => this.dispatch({ type: "tool.finished" }),
    }, () => environment.now());
  }

  get connection(): ConnectionState { return this.state.connection; }

  /** ConversationSource for the PresenceEngine; `now` is in seconds like the engine clock. */
  hints(now: number): ConversationHints { return liveHints(this.state, now * 1000); }

  busy(now = this.environment.now()): boolean { return liveBusy(this.state, now); }

  connect(microphone: MediaStream) {
    this.microphone = microphone;
    if (this.state.connection === "connecting" || this.state.connection === "connected" || this.state.connection === "reconnecting") return;
    this.attempts = 0;
    void this.open("connecting");
  }

  /**
   * Ends the session on purpose. A running session is closed gracefully: `session.close` is sent and the
   * old peer lingers (muted, detached from the body) until `session.closed` reports final usage, or a
   * short timeout passes. The new state is immediate, so a backend switch never waits for it.
   */
  disconnect(final: "disconnected" | "ended" = "disconnected") {
    const channel = this.channel, peer = this.peer;
    const graceful = this.state.connection === "connected" && channel?.readyState === "open" && peer !== undefined;
    const sessionId = this.state.sessionId, seconds = this.state.usageSeconds;
    this.generation++;
    if (graceful) {
      this.channel = this.peer = undefined;
      this.closeGracefully(peer, channel, sessionId, seconds);
      this.callbacks.onRemoteStream?.(null);
    }
    this.teardown();
    this.dispatch({ type: "connection", state: final });
  }

  send(event: LiveClientEvent): boolean {
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
    this.connectStartedAt = this.environment.now();
    const abort = new AbortController();
    this.abort = abort;
    const stale = () => generation !== this.generation;
    this.connectTimer = this.environment.setTimer(() => this.dropped(generation, new LiveConnectError("connect-timeout", true)), this.options.connectTimeoutMs);
    try {
      const peer = this.environment.createPeer();
      this.peer = peer;
      peer.ontrack = event => {
        if (stale()) return;
        this.callbacks.onRemoteStream?.(event.streams[0] ?? new MediaStream([event.track]));
      };
      peer.onconnectionstatechange = () => this.peerState(generation, peer);
      for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
      // The event channel must exist before the offer is created.
      const channel = peer.createDataChannel(EVENTS_CHANNEL);
      this.channel = channel;
      this.transport.channel = "connecting";
      channel.onopen = () => { if (!stale()) this.transport.channel = "open"; };
      channel.onclose = () => {
        if (stale()) return;
        this.transport.channel = "closed";
        this.dropped(generation, new LiveConnectError("data-channel-closed", true));
      };
      channel.onmessage = event => { if (!stale()) this.receive(generation, event.data); };
      const offer = await peer.createOffer();
      if (stale()) return;
      await peer.setLocalDescription(offer);
      await this.iceGathered(peer, generation);
      if (stale()) return;
      const sdp = peer.localDescription?.sdp || offer.sdp;
      if (!sdp) throw new LiveConnectError("webrtc-failed", true);
      const answer = await this.environment.createSession(sdp, abort.signal);
      if (stale()) return;
      this.dispatch({ type: "session.answered", sessionId: answer.sessionId, model: answer.model, backendModel: answer.backendModel, voice: answer.voice });
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      // Connected only once session.started arrives on the data channel.
    } catch (error) {
      if (stale()) return;
      this.dropped(generation, error instanceof LiveConnectError ? error
        : new LiveConnectError(error instanceof DOMException && error.name === "AbortError" ? "aborted" : "webrtc-failed", true));
    }
  }

  /** Resolves when ICE gathering completes, or after `iceGatheringMs` with whatever candidates exist. */
  private iceGathered(peer: LivePeerLike, generation: number): Promise<void> {
    this.transport.ice = peer.iceGatheringState;
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        this.environment.clearTimer(timer);
        peer.onicegatheringstatechange = null;
        if (generation === this.generation) this.transport.ice = peer.iceGatheringState;
        resolve();
      };
      const timer = this.environment.setTimer(done, this.options.iceGatheringMs);
      peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === "complete") done(); };
    });
  }

  private peerState(generation: number, peer: LivePeerLike) {
    if (generation !== this.generation) return;
    const state = peer.connectionState;
    this.transport.peer = state;
    this.environment.clearTimer(this.graceTimer);
    if (state === "failed" || state === "closed") {
      this.dropped(generation, new LiveConnectError("webrtc-failed", true));
    } else if (state === "disconnected") {
      this.graceTimer = this.environment.setTimer(() => {
        if (peer.connectionState === "disconnected") this.dropped(generation, new LiveConnectError("webrtc-disconnected", true));
      }, this.options.disconnectGraceMs);
    }
  }

  /** Unexpected loss: clean up, stop stale speaking/thinking, and retry a bounded number of times. */
  private dropped(generation: number, error: LiveConnectError) {
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
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.onicegatheringstatechange = null; try { peer.close(); } catch { /* already closed */ } }
    this.transport.peer = "closed"; this.transport.channel = "closed";
    this.delegation.reset();
    if (peer) this.callbacks.onRemoteStream?.(null);
  }

  /** Sends session.close on a detached peer and releases it after session.closed (or a timeout). */
  private closeGracefully(peer: LivePeerLike, channel: ChannelLike, sessionId: string | null, seconds: number) {
    peer.ontrack = null; peer.onconnectionstatechange = null; peer.onicegatheringstatechange = null;
    const release = (record: LiveCloseRecord) => {
      this.environment.clearTimer(timer);
      channel.onopen = channel.onclose = channel.onmessage = null;
      try { channel.close(); } catch { /* already closed */ }
      try { peer.close(); } catch { /* already closed */ }
      this.lastClose = record;
    };
    const unconfirmed = () => release({ sessionId, reason: "unconfirmed", seconds, confirmed: false });
    const timer = this.environment.setTimer(unconfirmed, this.options.closeGraceMs);
    channel.onmessage = message => {
      const event = parseLiveEvent(message.data);
      if (event.type === "usage") seconds = event.seconds;
      if (event.type === "session.closed") release({ sessionId, reason: event.reason, seconds: event.seconds ?? seconds, confirmed: true });
    };
    channel.onclose = unconfirmed;
    try { channel.send(JSON.stringify({ type: "session.close", event_id: "scf_close" } satisfies LiveClientEvent)); } catch { unconfirmed(); }
  }

  private receive(generation: number, data: unknown) {
    const event = parseLiveEvent(data);
    this.dispatch(event);
    if (event.type === "session.started" && this.state.connection !== "connected") {
      this.environment.clearTimer(this.connectTimer);
      this.attempts = 0;
      this.connectMs = this.environment.now() - this.connectStartedAt;
      this.dispatch({ type: "connection", state: "connected" });
    } else if (event.type === "session.closed") {
      // The server ended the session (expiry, safety filter, lost upstream). Content ends are final.
      this.lastClose = { sessionId: this.state.sessionId, reason: event.reason, seconds: event.seconds ?? this.state.usageSeconds, confirmed: true };
      this.dropped(generation, new LiveConnectError(`session-${event.reason}`, event.reason !== "content"));
      this.callbacks.onEvent?.(event);
      return;
    }
    this.delegation.handle(event);
    if ((event.type === "transcript.user" || event.type === "transcript.assistant") && event.text) this.transcript(event.type === "transcript.user" ? "user" : "assistant", event.text);
    this.callbacks.onEvent?.(event);
  }

  /** Live transcripts are fragments without turn boundaries: consecutive fragments of one speaker form a line. */
  private transcript(role: Transcript["role"], text: string) {
    const at = this.environment.now();
    const last = this.transcripts[this.transcripts.length - 1];
    if (last && last.role === role && at - last.at < 2500) { last.text += text; last.at = at; return; }
    this.transcripts.push({ role, text, at });
    if (this.transcripts.length > 20) this.transcripts.shift();
  }

  private dispatch(event: LiveStateEvent) {
    const next = reduceLive(this.state, event, this.environment.now());
    if (next === this.state) return;
    this.state = next;
    this.callbacks.onState?.(next);
  }
}

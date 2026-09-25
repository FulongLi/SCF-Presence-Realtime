/**
 * The small subset of the browser WebRTC API the voice clients use, so both adapters can be driven by
 * mocks in unit tests. These are transport shapes only; each backend keeps its own protocol.
 */

/** The subset of RTCDataChannel the clients use. */
export interface ChannelLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** The subset of RTCPeerConnection the clients use. */
export interface PeerLike {
  readonly connectionState: string;
  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown;
  createDataChannel(label: string): ChannelLike;
  createOffer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(description: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(description: { sdp: string; type: "answer" }): Promise<void>;
  close(): void;
  ontrack: ((event: { track: MediaStreamTrack; streams: readonly MediaStream[] }) => void) | null;
  onconnectionstatechange: ((event: Event) => void) | null;
}

/** The data-channel label OpenAI's WebRTC endpoints use for JSON events (Realtime and GPT-Live). */
export const EVENTS_CHANNEL = "oai-events";

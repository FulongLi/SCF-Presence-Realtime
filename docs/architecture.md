# Architecture

One test decides every design choice here: **does this make SCF feel like one AI with one living body?**

## Code map

```text
src/
  app/
    page.tsx, layout.tsx, globals.css   page reads SCF_VOICE_BACKEND per request
    api/realtime/token/route.ts   server-only: POST → ephemeral client secret (Realtime)
    api/live/session/route.ts     server-only: POST SDP offer → GPT-Live session → SDP answer
    api/visual/image/route.ts     optional, server-only: keyed web image search (off without a key)
  server/realtimeToken.ts         pure token logic (origin check, safety id, upstream call)
  server/liveSession.ts           pure GPT-Live session creation (same key, origin check, safety id)
  server/imageSearch.ts           pure keyed-image-search logic (Brave; fixed thumbnail host)
  voice/                          what both backends share
    backend.ts                    VoiceBackend = "realtime" | "live"; ?voice= → SCF_VOICE_BACKEND → realtime
    client.ts                     VoiceClient: the small interface PresenceController drives
    webrtc.ts                     PeerLike / ChannelLike (mockable WebRTC shapes)
    visualGuidance.ts             visual-body and visual-tool rules shared by both prompts
    tools/definitions.ts          the eight visual function tools (two open, six convenience): one schema
    tools/executor.ts             args → VisualAction → validate → VisualActionController (one executor)
    tools/results.ts              concise function_call_output payloads
  live/                           GPT-Live adapter (separate protocol, nothing shared with realtime/ events)
    session.ts                    Live session config: model, voice prompt, Responses delegation + tools
    instructions.ts               the short voice prompt and the backend prompt
    client.ts                     LiveClient: WebRTC, ICE gathering, session.started, graceful close, reconnect
    transport.ts                  browser environment: SDP offer → /api/live/session
    events.ts                     normalizes Live events and nested response.event; client event types
    delegation.ts                 LiveDelegationLoop: Responses function calls → executor → results → continue
    state.ts                      Live state reducer + full-duplex Presence hints + phase
  realtime/
    session.ts                    GA session config (model, voice, VAD, tools, instructions)
    instructions.ts               the agent prompt ("SCF is your visual body")
    client.ts                     RealtimeClient: WebRTC peer + data channel lifecycle, reconnect
    transport.ts                  browser environment: token fetch, SDP exchange with /v1/realtime/calls
    events.ts                     normalizes GA server events; client event types
    state.ts                      small state reducer + Presence hints + session phase
    conversation.ts               ToolCallLoop: the function-calling lifecycle
    identity.ts                   anonymous installation id (for the hashed safety identifier)
  audio/
    microphone/                   MicrophoneListener (track clone), VAD, emphasis
    assistant.ts                  remote track: <audio> playback + analyser
    analyser.ts, spectrum.ts      RMS envelope, 16 log-spaced bands
  presence/
    controller.ts                 PresenceController: owns the voice ⇄ body loop; active backend, switching, timings
    Presence.tsx, StageNotice.tsx React surface (particle stage + minimal notices)
    PresenceEngine.ts             modes and smoothed signal for the body
    focus.ts, signal.ts, strings.ts
  particle/                       WebGPU runtime, TSL physics, rendering, quality (ported)
  visual-actions/                 VisualAction schema, validation, VisualActionController (lifecycle)
  visual-resolver/                action → VisualTarget: providers, sources, transforms, particle sampling
    index.ts                      createBrowserResolver(): wires the providers below
    types.ts                      Raster2DTarget | HeightFieldTarget | Future3DTargetPlaceholder, provider interfaces, trace
    resolve.ts                    VisualResolver: dispatch, deadline, failure codes, trace
    net.ts                        the only network path: allowlists, timeouts, byte limits, MIME + magic bytes
    points.ts                     VisualTarget → particle rest positions and tones
    providers/images.ts           image provider chain per intent, fallback, download, normalize
    providers/rank.ts             deterministic candidate ranking
    providers/terrain.ts          terrain provider chain; relief-image fallback
    providers/glyphs.ts           clock, text, number, symbol (canvas)
    sources/localAssets.ts        curated first-party assets (manifest, matching, trusted same-origin loader)
    sources/wikimedia.ts          Wikipedia lead images, Wikimedia Commons file search
    sources/openverse.ts          Openverse open-license image search
    sources/webSearch.ts          client side of the optional keyed route
    sources/terrain.ts            geocoding (Nominatim, Photon) + AWS Terrain Tiles
    transforms/crop.ts            crop, background trim, resize, normalizeImage (pure)
    transforms/raster.ts          browser decoding (createImageBitmap + canvas)
    transforms/svg.ts             local SVG only: safety check, sizing, <img> → canvas, logo normalization
    transforms/heightfield.ts     terrarium decode, polygon mask, smoothing, normalization (pure)
  dev/debugPanel.ts               ?debug=1 diagnostics
```

public/assets/brand/              curated brand files (place spirit-connect-logo.svg here)

## Voice backends

```text
PresenceController
  ├─ client: RealtimeClient | LiveClient   (VoiceClient: connect, disconnect, hints, busy)
  ├─ runner: ToolExecutor (+ result timing) ── the only tool path, for both backends
  ├─ engine: PresenceEngine ◄─ hints (fullDuplex for Live) ◄─ client
  │                         ◄─ AssistantAudio ◄─ remote track ◄─ client
  └─ visual: VisualActionController ◄─ VisualResolver
```

The controller creates one client for the active backend. Each adapter keeps its protocol, events and state to itself and reports back through callbacks (state, events, remote stream) that the controller maps onto the shared body. Callbacks from a client that has been switched away from are ignored. `setBackend()` disconnects the current client (Live closes gracefully in the background), detaches its audio, interrupts any speaking state, creates the other client and connects it with the same microphone stream if one is open. The engine, audio graph, visual controller and any visual on show stay as they are.

The Realtime path is unchanged apart from moving the backend-agnostic tool code to `src/voice/tools/` and implementing `VoiceClient` (`backend`, `busy()`).

### GPT-Live session

```text
browser                                     SCF server                          OpenAI
RTCPeerConnection + mic track
createDataChannel("oai-events")   (before the offer)
createOffer → setLocalDescription → wait for ICE gathering (≤ 4 s; the offer is not trickled)
POST /api/live/session { sdp } ───────────► origin check, OPENAI_API_KEY
                                             POST /v1/live/sessions
                                             { session, transport: { type: "webrtc", sdp } } ──►
                                  ◄──────── { sdp, sessionId, model, ... } ◄── 201 { session.id, transport.sdp }
setRemoteDescription(answer)
data channel: session.started ─► connected (the client never sends session.start)
```

Session config ([`live/session.ts`](../src/live/session.ts)): `model` (`gpt-live-1`), the short voice `instructions`, `audio.output.voice` (no `audio.format`: WebRTC negotiates it), `delegation: { type: "responses", responses: { model: gpt-5.6-terra, instructions: backend prompt, tools: visualTools, tool_choice: "auto", parallel_tool_calls: false, reasoning? } }`, and `client.data_channel.allowed_client_events: ["response.item.create", "response.create", "session.close"]`, so the untrusted browser cannot change the session.

| GPT-Live server event | Effect |
| --- | --- |
| `session.started` | connected; session id, model, voice |
| `session.input_transcript.delta` | the user is talking (holds for 0.9 s); in-memory transcript |
| `session.output_transcript.delta` | the assistant replied (closes the "reply expected" window); in-memory transcript |
| `session.delegation.created` (`target: "responses"`) | a delegation is active: thinking when no assistant audio |
| `response.event` › `response.created` | backend response id for that delegation |
| `response.event` › `response.output_item.done` (`function_call`) | run the call (`call_id`, `name`, `arguments`) with the shared executor |
| `response.event` › `response.completed` / `failed` / `incomplete` | settle: continue with `response.create`, or end the delegation; backend token usage |
| `session.usage.updated` | cumulative voice seconds, context-window ratio |
| `session.closed` | final usage and reason; unexpected closes reconnect, except `content` (final) |
| `error`, acknowledgements | diagnostics |

There are no Live events for speech start/stop, the end of a spoken response, or barge-in. The body's speaking state comes from the actual remote audio, as with Realtime.

### Graceful close

`disconnect()` sends `session.close` on the old data channel, detaches the peer from the body at once, and keeps it open until `session.closed` (final usage and reason) or 3 s pass, then closes it. The debug panel shows whether final usage was confirmed.

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

Precedence in `PresenceEngine.sample()`: the backend says the user is speaking → listening (with Realtime this is barge-in; with GPT-Live only while the assistant is not audible, see below). Otherwise audible assistant audio → speaking. Otherwise local voice → listening. Otherwise a response is expected or a tool is running → thinking. Otherwise idle.

While the assistant is audible, the local microphone is treated as echo. Barge-in is left to OpenAI's VAD, which is also what cancels the response.

**GPT-Live (full duplex).** Its hints carry `fullDuplex: true` and are built from transcripts and delegations ([`live/state.ts`](../src/live/state.ts)): *user speaking* = an input transcript fragment in the last 0.9 s; *awaiting response* = an active delegation (bounded at 30 s without activity) or up to 2.5 s after the user stopped with no assistant reply yet; *tool active* as for Realtime. With `fullDuplex`, an audible assistant stays **speaking** while the user talks (backchannels are not a hard cancel). If the assistant's audio falls silent for 0.2 s while the user is still talking (the local microphone VAD, which is immediate; the lagging transcript hint is used only without microphone analysis), that is GPT-Live yielding: `interrupt()` runs, the cut is counted, and the body switches to **listening**. Backend work with no audible assistant is **thinking**.

Without a live session (e.g. during reconnect), the engine falls back to the original transcript-free inference: a finished utterance starts a bounded "thinking".

## Audio

- **One microphone request.** `requestMicrophone()` calls `getUserMedia` once with echo cancellation, noise suppression and AGC. The original track goes to the `RTCPeerConnection`. A **clone** (same source, no second prompt) goes to `MicrophoneListener`, which uses `MediaStreamTrackProcessor` where available and an `AnalyserNode` otherwise. Stopping analysis never stops what OpenAI hears, and the reverse.
- **Assistant audio.** The remote track plays through an `<audio>` element. Element playback gets echo cancellation, and Chrome needs a remote WebRTC stream attached to an element before Web Audio can read it. The same stream also feeds an `AudioMeter` (FFT 2048, RMS envelope, `SpectrumEnvelope` with 16 log-spaced bands from 60 Hz to 18 kHz) that is never connected to the speakers, so nothing plays twice.
- **Autoplay.** If an `AudioContext` cannot start without a gesture, the page waits for one tap before connecting, rather than letting the AI talk silently.

## Native function tools

The tools are defined once ([`voice/tools/definitions.ts`](../src/voice/tools/definitions.ts)) and executed by one `ToolExecutor` for both backends. The Realtime flow:

```text
Realtime model ── response.function_call_arguments.done {name, call_id, arguments}
      │
      ▼
ToolCallLoop ── dedupe by call_id (response.done output is a fallback)
      │
      ▼
ToolExecutor ── JSON.parse → toolCallToVisualAction → validateVisualAction → VisualActionController.submit
      │          → VisualResolver → VisualTarget → particle target
      │          (voice keeps playing; waits at most 1.5 s, else reports "forming")
      ▼
conversation.item.create { type: "function_call_output", call_id, output: '{"ok":true,"status":"displayed"}' }
      │
      └─ if the response only called tools and never spoke, and the user is not speaking:
         response.create  (the model continues, e.g. says the time it just showed)
```

- **One schema.** Tools resolve into the `VisualAction` union and go through the validator and controller. There is no second visual schema.
- **Tools.** `show_image { query, intent? }` and `show_terrain { region, style? }` are open: any query or place goes to the Visual Resolver. `show_clock`, `show_portrait`, `show_number`, `show_text`, `show_symbol` and `return_to_sphere` remain as convenience tools. `intent` and `style` are hints: an unknown value falls back to the default rather than failing the call.
- **Concurrency.** An image or terrain forms while the model keeps talking. `morphSpeechBlend()` fades destructive speaking forces early in the morph, and a small audio-reactive shimmer stays, so portraits, clocks and text remain readable during speech.
- **Failure** (invalid arguments, unknown tool, `image-not-found`, `image-unavailable`, `portrait-not-found`, `portrait-unavailable`, `region-not-found`, `terrain-unavailable`, superseded): the body stays or returns to the sphere, the model gets `{ ok: false, status }`, and it continues without the visual.
- **Silence about tools.** The instructions tell the model the visual channel is auxiliary and not to be narrated. A response that already spoke gets no follow-up, so the model has no reason to comment on the tool result.

The GPT-Live flow ([`live/delegation.ts`](../src/live/delegation.ts)):

```text
GPT-Live decides it needs help ── session.delegation.created { id, target: "responses" }
      │  (GPT-Live keeps talking; the body thinks only if nothing is audible)
      ▼
Responses backend ── response.event › response.created { id }
                  ── response.event › response.output_item.done { item: function_call { call_id, name, arguments } }
      │  (an arguments-done event alone is not used; lifecycle snapshots have output: [])
      ▼
same ToolExecutor ── VisualAction → validate → VisualActionController → VisualResolver → body
      ▼
response.item.create { item: { type: "function_call_output", call_id, output } }   (one per call)
      │
      └─ when the backend response completed and every call has a result:
         response.create   (the backend continues; GPT-Live speaks the outcome, e.g. the time)
```

Calls are deduplicated by `call_id`; a failed or incomplete response, or a closing session, is not continued; results that arrive after the session changed are dropped.

## Visual Resolver: open 2D and 2.5D visuals

SCF currently supports **open 2D and 2.5D visual expression**. True 3D object models are intentionally deferred.

### Before and after

The first version had a fixed visual vocabulary: each action type had its own hard-wired resolver (clock/number/text → canvas text, symbol → one of 12 drawn paths, portrait → one Wikipedia lead image). Anything else could not be shown.

```text
before:  tool ─► VisualAction ─► fixed per-type resolver ─► raster ─► particles

now:     tool ─► VisualAction (validated) ─► VisualResolver
                                               ├─ provider selection (by action and intent)
                                               ├─ retrieve or construct (fallback chain)
                                               ├─ normalize (crop, trim, resize / elevation grid)
                                               └─► VisualTarget ─► createTargetPoints ─► VisualActionController ─► body
```

The bottleneck is no longer a list of visual types. Two open tools cover most things worth seeing. The particle runtime only ever receives a `VisualTarget`, so it doesn't know whether a shape came from Wikimedia, Openverse, a web search, elevation tiles or a canvas.

### Targets

```ts
type VisualTarget = Raster2DTarget | HeightFieldTarget | Future3DTargetPlaceholder;
```

| Target | Used for | Sampling (`visual-resolver/points.ts`) |
| --- | --- | --- |
| `Raster2DTarget` `style: "portrait"` | people | luminance-weighted density, vignette, shallow luminance relief, photographic tones (unchanged) |
| `Raster2DTarget` `style: "object"` | vehicles, products, objects, maps, reference images | density follows the colour distance from the image's own background (border median), plus some luminance and edges, so a dark car on a white floor becomes the car, not the floor |
| `Raster2DTarget` `style: "glyph"` | clock, number, text, symbol | alpha-weighted crisp shapes, thin slab, even tones (unchanged) |
| `Raster2DTarget` `style: "logo"` | curated brand marks (local assets) | alpha silhouette (transparent background ignored), even density with strong outline and colour-boundary edges, no vignette, thin slab, tones from the mark's own luminance range (even light for a one-colour mark) |
| `HeightFieldTarget` | terrain, topography, relief, grayscale heightmaps | see below |
| `Future3DTargetPlaceholder` | nothing yet | cannot be constructed (`reserved: never`); the sampler rejects it |

Every sampler draws from a fixed-seed random sequence, so every adaptive-quality tier is a prefix of the same arrangement and shows the whole visual. The resolver samples each target once before handing it on, so an unusable target is rejected before it reaches the render loop.

### Local curated assets (first)

Before any image provider, `VisualResolver` asks the `local-assets` provider ([`sources/localAssets.ts`](../src/visual-resolver/sources/localAssets.ts)) whether the `show_image` query names a curated asset. Matching is deterministic: an exact normalized alias, or the brand name plus only logo words. A match is answered from the file under `public/assets/` or not at all: a missing, mistyped or unsafe file fails the action with `image-unavailable` and the trace records `local-assets: unavailable (…); no external fallback`. For first-party brand assets the wrong image is worse than none. Unmatched queries go to the providers below.

Loading: the path must be a manifest entry under `/assets/` (no traversal, no other origin), fetched through the guarded `safeFetch` with an empty host allowlist (so only the page's own origin), `Content-Type: image/svg+xml`, ≤ 1 MB, UTF-8. The SVG text must be self-contained and script-free ([`transforms/svg.ts`](../src/visual-resolver/transforms/svg.ts)); it gets explicit pixel dimensions from its `viewBox` (400 px longest side, aspect preserved), is drawn through an `<img>` onto a transparent canvas, and is normalized for the `logo` style (transparency kept, a plain opaque background keyed out, margins trimmed). Trace: `provider local-assets · source /assets/brand/spirit-connect-logo.svg · target raster2d/logo`.

### Image providers and fallback

Providers implement one interface and are isolated in `sources/`:

```ts
interface ImageProvider { name: string; search(query, intent, signal): Promise<ImageCandidate[]> }
```

| Provider | Source | Key | Notes |
| --- | --- | --- | --- |
| `wikipedia` | lead image of the matching article (exact title with redirects, then a search whose hit must share most of the query's words) | none | freely licensed images only (`pilicense=free`); language picked from the script (en/zh/ja/ko) |
| `commons` | Wikimedia Commons file search (`filetype:bitmap`; maps may be SVG drawings, used through their PNG thumbnails) | none | free licences |
| `openverse` | [Openverse](https://openverse.org) (Flickr, museums, Wikimedia and more), images through Openverse's own thumbnail endpoint | none | open licences; anonymous use is rate-limited |
| `web` | Brave Search images through SCF's server route | `BRAVE_SEARCH_API_KEY`, server only | optional; skipped when not configured |

The order depends on the intent ([`providers/images.ts`](../src/visual-resolver/providers/images.ts)):

| intent | order |
| --- | --- |
| portrait, celebrity | wikipedia → web → openverse → commons |
| vehicle, product, object | wikipedia → commons → web → openverse |
| map | commons → wikipedia → openverse |
| reference, general | openverse → commons → web → wikipedia |

For each provider in turn: search → rank the candidates → download the best (at most two per provider) → decode → normalize. The first image that gets through wins. A provider that errors, returns nothing usable, or whose downloads fail hands over to the next. The final failure is `*-not-found` when nothing matched, or `*-unavailable` when sources failed. `show_portrait` is the same chain with the portrait intent. Nothing in it is a list of supported people or things.

**Ranking** ([`providers/rank.ts`](../src/visual-resolver/providers/rank.ts)) is deterministic: relevance (query-word overlap with title/tags, accents folded, search rank), usable size (short side ≥ 160 px), an aspect ratio that suits the intent (portrait orientation for people, landscape for vehicles), a decodable raster type (JPEG/PNG/WebP; no GIF/SVG originals), source reliability, and a penalty for results that are *about* the subject but not a picture of it (signatures, logos, flags, graves, maps…) unless the query asks for them.

### Image normalization

1. **Safe fetch** ([`net.ts`](../src/visual-resolver/net.ts)): allowlisted hosts only, HTTPS, no redirects, no credentials or referrer, 8 s timeout, `Content-Type` allowlist, streamed byte limit (6 MB), then **magic-byte check** (the file must really be JPEG, PNG or WebP).
2. **Decode** in the browser (`createImageBitmap` + canvas) to at most 512 px, rejecting images over 40 MP or under 16 px.
3. **Crop** ([`transforms/crop.ts`](../src/visual-resolver/transforms/crop.ts)): portraits get a head-and-shoulders band (aspect 0.72–1.05, anchored near the top). Objects get a plain-background trim (only when the background really is plain, keeping a margin) and a gentle aspect clamp (0.6–2.2), so most of the vehicle or product survives. There's no computer-vision dependency.
4. **Resize** to at most 300 px (area averaging) and sample into particles.

### Terrain and height fields (2.5D)

```text
"Wales" ─► Nominatim (bounding box + simplified outline polygon) ─┐   Photon (extent) as fallback
                                                                  ▼
          normalizeBox: points grow to ~0.8°, continents capped at 70°, Mercator-safe latitudes
                                                                  ▼
          planTiles: highest zoom ≤ 12 with a ≤ 640 px window and ≤ 16 tiles
                                                                  ▼
          AWS Terrain Tiles (terrarium PNG: metres = R·256 + G + B/256 − 32768), decoded without colour management
                                                                  ▼
          mosaic → crop to the box → area-average to ≤ 160 cells a side → rasterize the outline as a mask
                                                                  ▼
          buildHeightField: land only (sea excluded unless the region is almost all water) → 3×3 smoothing
          → crop to the surface → normalize between the 1st and 99.5th percentile (minimum range 250 m,
          so flat countries stay flat) → relief grows with the real elevation range
                                                                  ▼
          HeightFieldTarget ─► particles
```

Heights come from **real elevation data** (SRTM, GMTED, ETOPO1 and others, about 30 m to 1 km). Brightness-to-height is used only as a fallback. If the elevation tiles can't be reached, the `relief-image` provider fetches a relief map through the image providers and reads its brightness as height, and the trace marks this `brightness (approximate)`. The same brightness path turns a local grayscale heightmap into terrain in the debug panel.

**Particles.** The grid lies on a ground plane tilted back 0.9 rad from the viewer: X is east, the plane recedes northward, and Z (up from the plane) is the normalized height × relief (at most 0.8 world units). Mountains visibly rise and valleys sink from the default camera, and the material's existing slow depth sway adds a little parallax. There is no orbital camera. Particles are spread evenly over the surface, a little denser on steep ground so ridges read, with bilinear heights between cells so there's no terracing. Tones are hillshading lit from the north-west, varied by `style`: `terrain` (shade + height), `relief` (strong shading, 1.3× relief), `topography` (contour bands every tenth of the range) and `heightmap` (height only).

### Speech while a visual is formed

Unchanged: `morphSpeechBlend()` fades the destructive speaking forces early in the morph, and the formed state keeps a bounded audio shimmer along the view axis. Images stay recognizable and terrain stays readable, but the body is never frozen. Every visual is temporary: sphere → visual → hold (image 12 s, portrait 14 s, terrain 14 s) → sphere.

### Guardrails

The visual space is open, but the implementation stays bounded.

| Guard | Value |
| --- | --- |
| Hosts (browser) | `*.wikipedia.org`, `commons.wikimedia.org`, `upload.`/`thumb.wikimedia.org`, `api.openverse.org`, `nominatim.openstreetmap.org`, `photon.komoot.io`, `s3.amazonaws.com` (elevation tiles), same-origin `/api/visual/image` |
| Hosts (server route) | `api.search.brave.com` (search), `imgs.search.brave.com` (thumbnails): not an open proxy |
| Protocol | HTTPS only, no ports, no userinfo, no redirects, `credentials: "omit"`, `no-referrer` (Nominatim gets the origin, per its usage policy) |
| Sizes | image ≤ 6 MB, JSON ≤ 3 MB (Wikimedia ≤ 1 MB), elevation tile ≤ 1 MB, URL ≤ 2048 chars |
| Formats | JPEG, PNG, WebP by `Content-Type` **and** magic bytes. SVG, GIF, HTML and scripts are refused. The one exception is SVG from curated same-origin `/assets/` paths, which must pass the SVG safety check and is rendered to pixels. |
| Dimensions | decode ≤ 40 MP, raster target ≤ 300 px, height field ≤ 160 cells a side, ≤ 16 tiles |
| Time | 8 s per request, 20 s per resolution (then `*-unavailable`); the voice never waits |
| Input | queries ≤ 100 chars, regions ≤ 80: letters, digits and ordinary punctuation. No markup, control/bidi characters, URLs or schemes. Only ever sent as search text. |
| Execution | remote content is decoded into pixels and never inserted into the page |
| Secrets | the browser has none; `BRAVE_SEARCH_API_KEY` is read only by the server route |

### Debugging

`?debug=1` → **visual resolver** shows the last action, query or region, intent or style, every provider consulted with its outcome and latency (the fallback chain), the selected provider, source and source type (licence, elevation vs. brightness), target type, raster or height-field size, normalized height range and real elevation range, fetch latency, resolver latency and final status. **tools** has one-click acceptance tests through the real `ToolExecutor` (portrait: Nikola Tesla; image: Tesla Model Y, Taylor Swift, futuristic concept car; terrain: Wales, United Kingdom; clock, text, number, symbol, sphere), free-form `show_image` / `show_terrain` inputs, and a local file loader (as portrait, object or heightmap).

### Limitations

- Image choice is heuristic (no vision model). A search can return a related but wrong picture, especially for descriptive queries. Wikipedia lead images favour the canonical subject.
- Portraits use a fixed head-and-shoulders band rather than face detection.
- Without `BRAVE_SEARCH_API_KEY`, imagery is limited to openly licensed sources. Recent products and some public figures may have no usable open image, and the tool reports `image-not-found` or `portrait-not-found`.
- Terrain relies on third-party public services (Nominatim, Photon, AWS Terrain Tiles, Openverse). They can be rate-limited or unreachable, and the resolver reports `terrain-unavailable` or `image-unavailable`.
- Terrain uses one geocoder hit (the most important match), one zoom level and a coarse grid. Very small features lose detail, and continent-scale regions are capped. The outline mask comes from OpenStreetMap boundaries, and sea is removed by elevation (≤ 0 m), so land below sea level (e.g. Dutch polders) can look missing.
- Elevation decoding reads exact canvas pixels. Browsers that add fingerprinting noise to canvas readback (e.g. Safari Private Browsing) perturb the decoded heights. Smoothing and percentile normalization absorb small noise, but the relief can look rougher there.
- The keyed route relies on the origin check only (like the token route). Put authentication in front of public deployments.

### Future: true 3D

The seam is `VisualTarget`. True 3D would add members such as:

- `PointCloudTarget`: positions (and colours) sampled from scans or photogrammetry;
- `MeshSampleTarget`: surface samples of a glTF/OBJ/STL mesh (area-weighted, normals for lighting);
- `VolumetricTarget`: density fields sampled inside a volume.

Each needs one type in `visual-resolver/types.ts`, one sampler branch in `points.ts`, and a provider (a `ModelProvider` beside `ImageProvider`/`TerrainProvider`), plus probably an orientation/turntable control in the runtime. The resolver, the tools, the controller lifecycle and the speech blending stay as they are. Model loading (glTF/OBJ/STL), mesh ingestion and point clouds are deliberately **not** implemented yet.

## Interruption / barge-in

**Realtime.** Turn detection is configured with `create_response: true, interrupt_response: true`. When the user starts talking over the assistant:

1. OpenAI's VAD emits `input_audio_buffer.speech_started`, and the body switches to **listening** at once.
2. The server cancels the response and cuts unplayed audio (WebRTC: `output_audio_buffer.cleared`, then `response.done` with `status: "cancelled"`, `reason: "turn_detected"`).
3. On `cleared`, `PresenceEngine.interrupt()` ends speaking without waiting for the audio release. For 350 ms it ignores assistant audio still in the jitter buffer, and it skips the speaker-echo guard, because the user really is speaking.
4. A tool-only response that was cancelled gets no continuation. The user's new turn gets its own response.

The client sends no cancel events itself. With WebRTC, the server's own interruption handling is authoritative and it truncates the conversation correctly.

**GPT-Live.** GPT-Live listens while it speaks and decides itself whether to yield (its prompt says: stop speaking when the user interrupts). SCF sends nothing and forces no Realtime-style turn-taking: user speech during audible assistant audio keeps the body speaking; the assistant's audio stopping under the user's voice is the interruption the body reacts to (see [Presence state mapping](#presence-state-mapping)). Backend work continues through an interruption, as the GPT-Live docs describe.

## Connection, reconnection and errors

- **Single session.** Every (re)connect bumps a generation counter and tears down the previous peer and data channel. Late callbacks from an old generation are ignored. `connect()` while connecting or connected does nothing. React StrictMode's double mount is covered by `PresenceController.stop()`.
- **Unexpected loss** (data channel closed, peer `failed`, peer `disconnected` for more than 4 s, 20 s connect timeout): tear down, clear the remote stream, reset the tool loop, clear stale speaking/thinking, then retry after 1 s, 3 s and 8 s. After that the state is `error` with a **Try again** notice.
- **GPT-Live** uses the same bounded reconnect. An unexpected `session.closed` (`expired`, `connection_lost`, `remote_hangup`) reconnects; `content` (a safety close) is final.
- **Permanent errors** are not retried: `not-configured`, `invalid-api-key`, `forbidden-origin`, `rate-limited`, `upstream-rejected`, and non-401 4xx responses from the SDP exchange.
- **Microphone denied or unavailable, WebGPU unavailable, device lost, image/portrait/terrain not found or unavailable, remote audio blocked:** each shows a one-line notice or degrades quietly. None of them stops the rest of the page.

## Server

`POST /api/realtime/token` ([route](../src/app/api/realtime/token/route.ts), [logic](../src/server/realtimeToken.ts)):

1. Refuses when no key is configured (503), when the Origin is foreign or missing (403), or when the body is malformed (400).
2. Builds the GA session: `type: "realtime"`, model, instructions, `output_modalities: ["audio"]`, `audio.input` (near-field noise reduction, turn detection, optional transcription), `audio.output.voice`, tools, `tool_choice: "auto"`.
3. Posts to `https://api.openai.com/v1/realtime/client_secrets` with `expires_after: { anchor: "created_at", seconds: 60 }` and an `OpenAI-Safety-Identifier` header (a salted hash of the installation id).
4. Returns `{ value, expiresAt, model, voice }`, with `Cache-Control: no-store`.

`POST /api/live/session` ([route](../src/app/api/live/session/route.ts), [logic](../src/server/liveSession.ts)):

1. The same key, origin and body checks (the body is `{ sdp, installationId }`, ≤ 64 KB, and `sdp` must look like an SDP offer).
2. Builds the Live session config (above) and posts `{ session, transport: { type: "webrtc", sdp } }` to `https://api.openai.com/v1/live/sessions` with the `OpenAI-Safety-Identifier` header.
3. Returns `{ sdp, sessionId, model, backendModel, voice }` from the `201` response, with `Cache-Control: no-store`. Errors map to the same codes as the token route.

The server does not proxy audio, store anything, run STT/TTS/LLM, or execute tools.

`POST /api/visual/image` ([route](../src/app/api/visual/image/route.ts), [logic](../src/server/imageSearch.ts)) is optional. Without `BRAVE_SEARCH_API_KEY` it answers `503 not-configured` and the browser stops asking for the rest of the page. With a key, it applies the same origin check, validates `{ query, intent }` with the shared `VisualAction` validator, and searches Brave with `safesearch=strict`. It then downloads at most three candidate thumbnails, only from `imgs.search.brave.com`, with the same guards as the browser, and returns only image bytes (`Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; sandbox`). The key never appears in a response.

## Ported from SCF-AI-Presence

**Copied with small edits** (see git history for the diff against the reference):

- `config/particleDefaults.ts`
- `particle/`: `ParticleRuntime` (semantic focus input removed), `ParticleScene`, `ParticleSystem`, `interaction/pointer`, `physics/*`, `rendering/material` and `postfx` (restrained bloom), `sphere/createSphere`, `quality` (adaptive tiers), `speechMotion`, `morphBlend`
- `presence/focus.ts`, `presence/signal.ts` (the provider-only `semanticFocus` was removed)
- `audio/analyser.ts`, `audio/spectrum.ts`, `audio/microphone/vad.ts`, `audio/microphone/emphasis.ts`
- `visual-actions/types`, `validate`, `controller`, and the original `resolve`, `portrait/wikimedia`, `targets/points`, `targets/rasterize` (since generalized into `visual-resolver/`: `resolve.ts`, `sources/wikimedia.ts`, `points.ts`, `providers/glyphs.ts`)
- Tests: microphone, quality, spectrum, speech motion, visual actions

**Adapted:**

- `PresenceEngine`: the provider hint is replaced by Realtime `ConversationHints` (server VAD, awaited response, tool activity) and an explicit `interrupt()` for barge-in. Inference only runs when there is no live session.
- `MicrophoneListener`: no longer calls `getUserMedia` itself. It analyses a clone of the shared stream's track.
- `strings.ts`: new setup and connection lines (en/zh).
- The debug panel is rebuilt around Realtime diagnostics and the native tool path.

**Deliberately not copied:** `extensions/presence-bridge/`, `services/mcp-relay/`, `src/bridge/`, `src/relay/`, `audio/tabShare.ts`, the local Visual Intent interpreter, TurnTracker, the ChatGPT and Grok DOM adapters, the `SCF_ACTION` parser, MCP OAuth and pairing, the Cloudflare relay, the semantic arbiter/fingerprint (every visual now has one intentional source), `optional/api-mode/` (the old chained text/TTS API mode), the static-export and GitHub Pages pipeline, and the extension build scripts.

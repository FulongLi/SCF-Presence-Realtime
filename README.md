# SCF Presence Realtime

SCF Presence Realtime is a native realtime voice AI with a living visual body. It connects directly to a realtime conversational model over WebRTC and reacts physically to listening, thinking and speaking. The AI can also choose to show information with its particle body, using native function tools.

It has **two selectable voice backends** that drive the same body, for A/B comparison: the **OpenAI Realtime API** (the stable baseline) and **GPT-Live** (`gpt-live-1`, full duplex) with a **Responses backend** that reasons and selects the same visual tools. See [Voice backends](#voice-backends-realtime-and-gpt-live).

The particle sphere is the interface. There is no chat window, waveform or dashboard. The AI hears you, thinks, answers in its own voice, and sometimes takes a brief visual shape. That can be a person, a car, a product, a map, the terrain of a real region, or a time, number, word or symbol. Then it returns to the sphere.

SCF supports **open 2D and 2.5D visual expression**: the AI isn't limited to a fixed set of icons. A Visual Resolver finds or builds an appropriate picture or height field for whatever is worth seeing. **True 3D object models are intentionally deferred** (see [the future 3D direction](docs/architecture.md#future-true-3d)).

```text
sphere  →  temporary visual expression  →  sphere
```

## Architecture

```text
SCF Presence
├── Realtime backend   (src/realtime/)  one model listens, speaks and selects visual tools
└── GPT-Live backend   (src/live/)      gpt-live-1 listens and speaks (full duplex)
      └── Responses delegation          gpt-5.6-terra reasons and selects the visual tools
            └── SCF visual tools        the same definitions, ToolExecutor, Visual Resolver and body
```

The Realtime path in detail (GPT-Live differs only in the box at the top and the server route; see [Voice backends](#voice-backends-realtime-and-gpt-live)):

```text
                          ┌──────────────────────────┐
                          │ OpenAI Realtime API (GA) │
                          │ speech-to-speech         │
                          │ conversation state       │
                          │ native function calls    │
                          └───────────┬──────────────┘
                     WebRTC audio  ▲  │  data channel "oai-events"
                                   │  ▼
┌──────────────────────────────────────────────────────────────┐
│ Browser · SCF Presence Realtime                              │
│                                                              │
│ Microphone (one stream) ──track──────────────► OpenAI        │
│      └─ clone ─► local VAD / emphasis ──────► LISTENING, focus│
│                                                              │
│ Realtime turn/response events ──────────────► THINKING, turns│
│ Remote assistant audio ─► <audio> playback                   │
│                         └► analyser (RMS + 16 bands) ► SPEAKING│
│ Native function calls ─► ToolExecutor ─► VisualAction        │
│   ─► Visual Resolver (images · terrain · glyphs) ─► morph    │
│                                                   Particle body ●│
└──────────────────────────────────────────────────────────────┘
          │ POST /api/realtime/token (once per session)
          ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ SCF server (tiny)        │──key──►│ /v1/realtime/            │
│ mints ephemeral secret   │◄─ek_───│ client_secrets           │
└──────────────────────────┘        └──────────────────────────┘
```

- **Voice** is native speech-to-speech over WebRTC. There is no STT → LLM → TTS chain, and audio never passes through our server.
- **Visuals** come from native Realtime function tools executed in the browser. The Visual Resolver turns them into targets using open sources (Wikipedia, Wikimedia Commons, Openverse, OpenStreetMap geocoding, AWS Terrain Tiles). Nothing parses transcripts, reads the DOM, runs through MCP or a relay, or guesses a visual.
- **The server** has one job: use the permanent `OPENAI_API_KEY` to start a session with a fixed config. For Realtime it mints a short-lived client secret; for GPT-Live it creates the session from the browser's SDP offer and returns only the SDP answer.

More detail, including how each part maps to the code: [docs/architecture.md](docs/architecture.md).

## Setup

Requirements: Node 22+, and a desktop browser with WebGPU (current Chrome, Edge or Safari) for the particle body.

```bash
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY=sk-...
npm install
npm run dev
```

Open <http://localhost:3000> and allow the microphone. Then talk.

### API key handling

- One key for both backends. `OPENAI_API_KEY` is read only by the server routes [`src/app/api/realtime/token/route.ts`](src/app/api/realtime/token/route.ts) and [`src/app/api/live/session/route.ts`](src/app/api/live/session/route.ts), which import `server-only`. It is never bundled into the browser or returned in a response.
- **Realtime:** the browser receives only an ephemeral client secret (`ek_…`). The secret lives for 60 seconds, just long enough for the WebRTC SDP exchange with `https://api.openai.com/v1/realtime/calls`.
- **GPT-Live:** the browser sends its SDP offer to SCF's server, which calls `POST https://api.openai.com/v1/live/sessions` with the key and returns only `{ sdp, sessionId, model, backendModel, voice }`. The browser holds no credential at all, and the session restricts the browser's data channel to returning tool results, continuing the backend, and closing.
- Models, voices, instructions, tools and turn detection are fixed on the server, so the browser cannot change them.
- `.env*` files are git-ignored, except `.env.example`, which contains no values.
- The token route only accepts requests from the app's own origin (plus `SCF_ALLOWED_ORIGINS`). That stops other websites from spending your key through a visitor's browser. It is **not** authentication: any public deployment lets any visitor start sessions billed to your key. Put auth in front of it for anything beyond personal use.

### Configuration (`.env.local`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Standard API key, server-only, used by both backends |
| `SCF_VOICE_BACKEND` | `realtime` | `realtime` or `live`. `?voice=realtime\|live` overrides it per page load |
| `OPENAI_LIVE_MODEL` | `gpt-live-1` | GPT-Live voice model |
| `OPENAI_LIVE_BACKEND_MODEL` | `gpt-5.6-terra` | Responses model GPT-Live delegates to (`gpt-5.6-luna` for lower cost) |
| `OPENAI_LIVE_VOICE` | `marin` | GPT-Live output voice (`marin`, `cedar`, `quartz`, `gleam`, …) |
| `OPENAI_LIVE_BACKEND_REASONING` | model default | Backend reasoning effort (`none` … `xhigh`, as the model supports) |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | GA Realtime model |
| `OPENAI_REALTIME_VOICE` | `marin` | Output voice (`marin`, `cedar`, `alloy`, …) |
| `OPENAI_REALTIME_TURN_DETECTION` | `semantic_vad` | `semantic_vad` or `server_vad` |
| `OPENAI_REALTIME_VAD_EAGERNESS` | `auto` | `low`, `medium`, `high` or `auto` (semantic VAD) |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | off | e.g. `gpt-4o-mini-transcribe`, to get user transcripts in `?debug=1` (extra cost) |
| `SCF_SAFETY_ID_SALT` | built-in | Salt for the hashed safety identifier; set a random value in production |
| `SCF_ALLOWED_ORIGINS` | none | Extra origins allowed to request tokens or Live sessions |
| `BRAVE_SEARCH_API_KEY` | off | Optional web-scale image search for `show_image`/`show_portrait`, server-only (see [Visual Resolver](#visual-resolver)) |
| `NEXT_PUBLIC_SCF_DEBUG` | off | `1` enables `?debug=1` in production builds |

Invalid values fall back to the defaults and are never forwarded.

## Voice backends: Realtime and GPT-Live

Both backends share everything except the protocol adapter: the one microphone stream, `MicrophoneListener`, `AssistantAudio`, `PresenceEngine`, the particle system, the visual tool definitions, the `ToolExecutor`, the Visual Resolver and the local brand assets. The particle body does not know which backend is talking.

| | Realtime (`src/realtime/`) | GPT-Live (`src/live/`) |
| --- | --- | --- |
| Session | browser → SCF (`/api/realtime/token`) → ephemeral secret → browser posts SDP to `/v1/realtime/calls` | browser posts a complete SDP offer to SCF (`/api/live/session`) → SCF posts `{ session, transport: { type: "webrtc", sdp } }` to `/v1/live/sessions` → SDP answer; ready on `session.started` |
| Who selects tools | the Realtime model | the Responses backend (`delegation.type: "responses"`) |
| Prompt | one prompt ([`realtime/instructions.ts`](src/realtime/instructions.ts)) | a short voice prompt, and a backend prompt with the detailed visual rules ([`live/instructions.ts`](src/live/instructions.ts)); the visual rules are shared word for word ([`voice/visualGuidance.ts`](src/voice/visualGuidance.ts)) |
| Tool call | `response.function_call_arguments.done` | nested `response.event` › `response.output_item.done` (a finished `function_call` item) |
| Tool result | `conversation.item.create` (+ `response.create` if the response never spoke) | `response.item.create { function_call_output }` for every call, then `response.create` to continue the backend |
| Turns | OpenAI VAD `speech_started`/`stopped`; barge-in = `output_audio_buffer.cleared` | full duplex: no turn or barge-in events. Transcript deltas show who is talking; the assistant's audio stopping under the user is the cut |
| Usage | per-response tokens | voice seconds (`session.usage.updated`), backend tokens from nested completions, final usage from `session.closed` |
| End | close the peer | `session.close`, wait for `session.closed` (up to 3 s), then close |

**Switching.** Set `SCF_VOICE_BACKEND=live` (default `realtime`), or open `/?voice=live` or `/?voice=realtime` (the query parameter wins, then the environment, then `realtime`). With `?debug=1`, the **voice backend** section has a Realtime / GPT-Live switch: it closes the current session, starts the other backend on the same microphone stream, keeps the body and any visual on show, and writes `?voice=` into the URL.

**Presence state with GPT-Live.** The user may speak while the assistant is audible (backchannels, asides). An audible assistant stays **speaking**; if GPT-Live yields and its audio stops while the user keeps talking, the body switches to **listening** within about 0.2 s (counted as a cut). Backend work with no audible assistant is **thinking**. Speaking always comes from the real assistant audio, never from transcripts.

## Native visual tools

The model gets eight function tools (see [`src/voice/tools/definitions.ts`](src/voice/tools/definitions.ts)). The same definitions are registered as Realtime `session.tools` and as GPT-Live `delegation.responses.tools`. Two are open. The rest are convenience shapes. There are no per-object tools like `show_car`, `show_mountain` or `show_company_logo`.

| Tool | Arguments | Becomes |
| --- | --- | --- |
| `show_image` | `{ query, intent? }`, intent ∈ portrait, celebrity, object, vehicle, product, reference, map, general | `{ type: "image", query, intent }`. Any person, vehicle, product, object, logo, place, map or reference image: a curated local asset if the query names one, otherwise the image provider chain. |
| `show_terrain` | `{ region, style? }`, style ∈ terrain, topography, relief, heightmap | `{ type: "terrain", region, style }`. Real elevation of any geocodable place as a 2.5D relief. |
| `show_clock` | `{ time?: "HH:MM" }` | `{ type: "clock", time? }`. With no time it shows the local time, and the result tells the model that time. |
| `show_portrait` | `{ person }` | `{ type: "portrait", person }`. The same image chain with the portrait intent: Wikipedia first, then other sources. |
| `show_number` | `{ value }` | `{ type: "number", value }`, e.g. `42%`, `23°C`, `£28,000` |
| `show_text` | `{ value }` | `{ type: "text", value }`, one short word or label |
| `show_symbol` | `{ symbol }` | `{ type: "symbol", value }`: check, cross, heart, star, question, exclamation, arrow-up/down/left/right, plus, minus |
| `return_to_sphere` | `{}` | `{ type: "sphere" }` |

Every call maps onto the **same `VisualAction` schema** and passes strict `validateVisualAction()` checks before reaching the `VisualActionController`. Those checks are allowlists, length limits, no markup, URLs or control characters, and no unknown fields. Open queries are only ever used as search text.

Realtime lifecycle: `response.function_call_arguments.delta` (assembled per `call_id`) → `…arguments.done` → validate and execute locally, while the voice keeps playing → `conversation.item.create { type: "function_call_output" }` with a concise result. Examples: `{"ok":true,"status":"displayed"}`, `{"ok":true,"status":"forming"}` (still downloading after 1.5 s), `{"ok":false,"status":"image-not-found"}`, `{"ok":false,"status":"terrain-unavailable"}`. If a response only called tools and never spoke, SCF sends `response.create` so the model can continue. A response that already spoke gets no follow-up, so the model never narrates its tools.

GPT-Live lifecycle: `session.delegation.created` (the body may think) → nested `response.created` → nested `response.output_item.done` with the finished function call → the same `ToolExecutor` → `response.item.create { function_call_output }` → once the backend response completed and every call has a result, `response.create` → the backend reports the outcome and GPT-Live says it.

## Visual Resolver

```text
tool call ─► validated VisualAction ─► Visual Resolver ─► VisualTarget ─► particle target ─► sphere → visual → sphere
                                        │
                                        ├─ glyphs   clock · number · text · symbol  (canvas)
                                        ├─ images   local curated assets FIRST → wikipedia · commons · openverse · web(optional)  → Raster2DTarget
                                        │           (local assets: public/assets/, e.g. the Spirit Connect logo → raster2d/logo)
                                        └─ terrain  geocoder → AWS elevation tiles (→ relief image)  → HeightFieldTarget
```

- **Open image retrieval.** Providers are tried in an order that suits the intent. For each one, candidates are ranked deterministically (relevance, size, aspect, format, source, off-topic penalty), the best ones are downloaded safely, and the first image that downloads and decodes cleanly is used. If a provider is down, returns nothing, or its downloads fail, the next one takes over. No lists of supported objects or people exist anywhere.
- **Portraits** are no longer tied to Wikipedia. Wikimedia is one provider among several, and portraits get a head-and-shoulders crop.
- **Normalization.** Guarded fetch, then format validation by `Content-Type` and magic bytes (JPEG/PNG/WebP), byte and dimension bounds, and decoding. Then an intent-aware crop (portrait band, or plain-background trim for objects) and a resize to at most 300 px.
- **Terrain (2.5D).** The region is geocoded with OpenStreetMap Nominatim, which returns its outline, with Photon as fallback. Real elevation in metres comes from keyless AWS Terrain Tiles (≤ 16 tiles). The outline masks the grid, the sea is removed, and heights are normalized between percentiles. Particles form a tilted relief surface: mountains rise, valleys sink, hillshaded in the chosen style.
- **Optional key.** With `BRAVE_SEARCH_API_KEY`, a server route adds web-scale image search. It downloads only from Brave's thumbnail host and returns only image bytes. The key never reaches the browser. Without it, everything else works keyless.

- **Local brand assets first.** A `show_image` query that names a curated first-party asset (e.g. "Spirit Connect logo", "our company logo") is answered from the repository, never from a public search. See [Local brand assets](#local-brand-assets).

Details, guardrails and the future 3D extension point: [docs/architecture.md → Visual Resolver](docs/architecture.md#visual-resolver-open-2d-and-25d-visuals).

## Local brand assets

Your own company assets should not depend on public image search. They live in the repository under `public/assets/` and are listed in a small manifest, [`src/visual-resolver/sources/localAssets.ts`](src/visual-resolver/sources/localAssets.ts):

```ts
{
  id: "spirit-connect-logo",
  brand: "Spirit Connect",
  type: "logo",
  path: "/assets/brand/spirit-connect-logo.svg",
  aliases: ["spirit connect", "spiritconnect", "spirit connect logo", "our company logo", "my company logo", "company logo"],
}
```

**Place the logo at `public/assets/brand/spirit-connect-logo.svg`.** The repository does not ship a logo (none is invented or redrawn). Until the file exists, asking for the logo fails with `image-unavailable`.

- **Resolution order:** `show_image` → local curated assets → Wikipedia → Wikimedia Commons → Openverse → optional web search. No `show_company_logo` tool is needed.
- **Matching is deterministic and auditable:** the query is normalized (lower case, accents folded, possessives and punctuation removed, a leading "the" ignored) and must either equal an alias exactly, or contain the brand name ("Spirit Connect" or "SpiritConnect") with only logo words around it (logo, brand, mark, icon, emblem, symbol, company, official, our, my, …). "company" or "logo" alone never match; "Spirit Connect headquarters" does not match. "Our company logo" maps to Spirit Connect only because the manifest says so.
- **No wrong logo:** if a query matches the manifest but the file is missing, not an SVG, or unsafe, the action fails (`image-unavailable`, trace: `local-assets: unavailable (…); no external fallback`). Generic queries use the normal external chain.
- **Safe SVG:** SVG is accepted only for these trusted, same-origin paths (`/assets/…`, no traversal, no other origin). The text must be self-contained and script-free (no `<script>`, event handlers, `foreignObject`, entities, or external `href`/`url()`), then it is rendered through an `<img>` (secure static mode) onto a canvas at the SVG's own aspect ratio (400 px longest side). Remote SVGs are still refused everywhere.
- **Logo style:** `raster2d/logo`: transparency is kept (a plain opaque background such as a white rectangle is keyed out), margins are trimmed, and particles follow the mark's silhouette with strong edges, even density, no photographic vignette, and tones from the mark's own contrast.
- **Adding assets** (another logo, product marks, internal illustrations): put the file under `public/assets/…` and add an entry with explicit aliases. PNG, WebP and JPEG work too.

## Privacy

| Data | Where it goes |
| --- | --- |
| Microphone audio | Straight to OpenAI (Realtime API or GPT-Live) over WebRTC, only while a session is open |
| Assistant audio | OpenAI → your browser |
| Particle and audio analysis (VAD, emphasis, spectrum) | Stays in the browser |
| Visual Action execution | Stays in the browser |
| Image lookup (`show_image`, `show_portrait`) | Only the query text, sent anonymously (no cookies, no referrer) to Wikipedia/Wikimedia Commons and Openverse, and only when a visual is requested. Images are downloaded from their image hosts. With `BRAVE_SEARCH_API_KEY`, the query also goes through SCF's server to Brave Search. |
| Terrain lookup (`show_terrain`) | Only the region name, to OpenStreetMap Nominatim (with the page origin, per its usage policy) or Photon. Elevation tiles come from AWS Open Data. |
| Transcripts (optional) | Kept in page memory for `?debug=1`, never stored or sent anywhere |
| Installation id | A random id in `localStorage`. The server sends only a salted SHA-256 of it to OpenAI as `OpenAI-Safety-Identifier` (both backends). |
| Brand assets | Served from the app's own origin; never sent anywhere |

The server stores nothing: no database, no conversation, no transcripts, no audio. After 10 minutes without conversation the session ends and the microphone is released. Tap to resume.

**Safety identifier.** OpenAI recommends a stable, privacy-preserving per-user identifier, set server-side, when minting ephemeral Realtime secrets. There are no accounts, so SCF hashes the anonymous installation id with `SCF_SAFETY_ID_SALT` into `scf-<40 hex>`. OpenAI can link sessions from the same browser installation, but it gets no personal information, and the value cannot be linked across deployments that use different salts.

## Development

- `npm run dev`, then open `/?debug=1` for the development panel. It shows:
  - **Voice backend** switch (Realtime / GPT-Live) and status for the active backend. Realtime: WebRTC/data channel state, model, voice, session id and duration, response count, token usage. GPT-Live: WebRTC/ICE/data channel state, live model, backend model, voice, session id and duration, voice seconds and context use, backend tokens, delegations (total and active), backend responses, function calls, continuations, and how the last session closed (with or without confirmed final usage).
  - **Timings** for both backends, measured the same way: connect time, end of the user's speech → first assistant audio, tool result → spoken continuation (first audio), and for GPT-Live, delegation → function call.
  - Conversation state: OpenAI VAD, response active, interruptions (Realtime); input/assistant transcript activity, delegation, full-duplex cuts (GPT-Live).
  - Audio: user and assistant amplitude, spectrum bands.
  - Tools: last call, arguments, result.
  - Visual resolver: query or region, intent or style, provider fallback chain (including `local-assets`) with per-provider outcome and latency, selected provider and source, source type, target type and style (e.g. `raster2d/logo`), raster or height-field size, normalized height range and real elevation range, fetch and resolver latency, final status.
  - Presence: mode, visual phase, current visual, quality tier.
  - The in-memory transcript.
- It also has one-click manual tests through the real tool executor: portrait Nikola Tesla; images Tesla Model Y, Taylor Swift and a futuristic concept car; terrain Wales and United Kingdom; **local asset: Spirit Connect logo** (the local-asset resolver without OpenAI); clock, text, number, symbol, sphere. It adds free-form `show_image`/`show_terrain` inputs, direct Visual Actions, and a local file as portrait, object or heightmap. That way body, resolver and local-asset problems can be separated from model tool-selection problems, on either backend. It never shows the API key, the ephemeral secret or any provider key.
- The debug panel is not in production builds unless `NEXT_PUBLIC_SCF_DEBUG=1`.

## Testing

```bash
npm run lint
npm run typecheck
npm test        # deterministic unit tests, no network, no credentials
npm run build
```

The unit tests cover:

- **Body port:** presence states (offline and live), microphone VAD, acoustic emphasis/focus, spectrum, adaptive quality, sphere sampling, speech motion and morph blending, the Visual Action lifecycle, validation, clock/number/text/symbol and portrait sampling.
- **Visual Resolver** (all providers mocked):
  - Guarded fetch: host allowlist, no redirects or credentials, MIME and magic bytes, oversize by header and stream, timeouts vs cancellation.
  - Candidate ranking.
  - Wikipedia, Commons, Openverse and the keyed web provider.
  - Provider selection by intent, the fallback chain and its trace, not-found vs unavailable.
  - Crop, trim, resize and intent normalization, object sampling.
  - Resolver deadline and cancellation.
  - Terrain: terrarium decoding, polygon masks, box/zoom/tile bounds, geocoder fallback, masked elevation grids from synthetic tiles, height-field normalization (land only, percentiles, flat regions, oceans), non-flat tilted particle relief, invalid-target rejection, provider fallback, and the keyed server route (key isolation, fixed thumbnail host).
- **Realtime:** event normalization; the state machine (lifecycle, interruptions, usage, stale state on disconnect); tool definitions (including `show_image` and `show_terrain`), argument mapping and validation, and executor results for every tool; the function-call loop (argument assembly, output, continuation rules, barge-in, deduplication, stale sessions); and the WebRTC client with mocked peer, data channel and transport (connect, idempotent connect, events, tool round trip, interruption, disconnect, bounded reconnect, permanent errors, peer grace period, stale callbacks, connect timeout); assistant audio (playback of the real remote track, analysis into speaking amplitude and spectrum, autoplay blocking); and the controller's side-effect-free construction and teardown.
- **GPT-Live:** event normalization against the current Live event names (and that Realtime names are not accepted); the WebRTC client with mocked peer/channel (ICE gathering before the offer, connected only on `session.started`, no `session.start`, remote audio to `AssistantAudio`); Responses delegation (calls only from finished output items, `response.item.create` then `response.create`, one run per call id, no continuation for failed responses or a closing session, stale results dropped); hints (full duplex, reply window, stale delegations); graceful `session.close`/`session.closed` with a timeout; reconnect and permanent errors; the session route (same key, SDP forwarded, only the answer returned, frontend event allowlist, canonical tool definitions, split prompts, env fallbacks, error mapping).
- **Backend switching:** `?voice=` → `SCF_VOICE_BACKEND` → realtime; the engine's full-duplex rules (overlap stays speaking, a cut hands over to listening, Realtime priority unchanged); reply latency; the controller switching backends without replacing the body.
- **Local brand assets:** manifest, alias and brand matching (case-insensitive, company-logo aliases, unrelated queries never match), local-first priority with no external calls, missing/wrong-type/unsafe files failing without a web fallback, trusted paths only (no remote SVG), SVG safety checks, sizing and aspect ratio, transparency preservation and background keying, logo particle sampling, and `show_image` through the real `ToolExecutor`.
- **Server:** the ephemeral secret request (GA session shape, no beta header), the hashed safety identifier, configuration fallbacks, origin and body checks, upstream error mapping, and the key never appearing in a response.

The end-to-end check against OpenAI is a manual checklist: [docs/smoke-test.md](docs/smoke-test.md). CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, typecheck, tests and build with no API key. Network timeouts use ordinary (ref'd) timers, so the hung-request tests are deterministic on Node 22 in CI.

## Deployment

The app is a Next.js app plus one small server route, so it needs a host that runs Next.js server routes. A static export (e.g. GitHub Pages) won't work.

- **Vercel** (simplest): import the repository, set `OPENAI_API_KEY` (and optionally the other variables, e.g. `SCF_VOICE_BACKEND`) under Project → Settings → Environment Variables, then deploy. The token and Live session routes run on the Node.js runtime; the page reads `SCF_VOICE_BACKEND` per request.
- **Netlify, Cloudflare (OpenNext) or any Node host:** `npm run build && npm start` with the same environment variables.
- Serve over **HTTPS**, which the microphone requires. If you use a custom domain behind a proxy that rewrites `Host`, add it to `SCF_ALLOWED_ORIGINS`.
- Set `SCF_SAFETY_ID_SALT` to a random secret.

No database, queue, WebSocket server or extra infrastructure is needed.

## Current limitations

- **WebGPU is required for the body.** Without it, a notice appears but voice still works. There is no WebGL fallback yet.
- **No authentication.** Anyone who can load a public deployment can start sessions on your key. See [API key handling](#api-key-handling).
- **Echo:** SCF relies on the browser's echo cancellation and OpenAI's turn detection. On loud speakers without headphones, the assistant may occasionally interrupt itself.
- **Autoplay:** if the browser blocks audio without a gesture, the page asks for one tap ("Tap anywhere to begin") rather than letting the AI talk silently.
- **GPT-Live is new and fast-moving.** The adapter follows the GPT-Live documentation and API reference as of September 2026 (event names, `POST /v1/live/sessions`, Responses delegation). It has unit tests against those shapes, but it still needs a real end-to-end check with your key ([smoke test](docs/smoke-test.md)). GPT-Live has no barge-in or end-of-speech events, so the body infers the user taking the floor from the assistant's audio stopping while transcripts show the user talking, and "user speaking" follows transcript deltas, which arrive a little later than speech. Switching backends starts a new conversation. Backend usage is reported per nested response and may be missing if the API omits it.
- **The Spirit Connect logo is not in the repository yet.** Add `public/assets/brand/spirit-connect-logo.svg`; until then the logo request reports `image-unavailable`. SVG rendering itself happens in the browser and was checked through its pure parts (safety, sizing, normalization, sampling) in CI.
- **Reconnects start a new conversation.** OpenAI keeps the context only within a session. After a dropped connection or idle end, the model starts fresh.
- **Images** are chosen heuristically, with no vision model. Without `BRAVE_SEARCH_API_KEY` they come only from openly licensed sources, so some recent products or public figures may have no usable image. The tool then reports `image-not-found`/`portrait-not-found` and the conversation continues. Portrait crops use a fixed head-and-shoulders band, not face detection.
- **Terrain** is a 2.5D relief, not a GIS. It uses one geocoder match, one zoom level, a grid of at most 160 cells a side, and public services that can be rate-limited or unavailable (`terrain-unavailable`). Land below sea level is treated as sea.
- **No true 3D yet.** glTF/OBJ/STL models, meshes and point clouds are deliberately not supported. `VisualTarget` has a placeholder for them.
- **Visual quality was not verified in CI.** Rendering is tested through its pure parts (sampling, lifecycle, blending). The WebGPU output itself needs the manual smoke test.

## Relationship to SCF-AI-Presence

```text
SCF-AI-Presence        = integration layer for existing AI products
SCF-Presence-Realtime  = native API-first AI product
```

[SCF-AI-Presence](https://github.com/FulongLi/SCF-AI-Presence) gives a body to *someone else's* conversation: it follows ChatGPT through a Chrome extension, DOM observation, tab audio, an MCP relay and local Visual Intent inference. That complexity exists because it does not own the conversation.

This repository owns the conversation. It keeps SCF-AI-Presence's mature particle body and presence physics: the WebGPU runtime, sphere, pointer interaction, idle/listening/thinking/speaking physics, acoustic focus, spectrum response, adaptive quality, Visual Actions, portrait sampling, text/number/clock/symbol rendering, speech/morph blending and bloom/material. It drops everything provider-specific (see [docs/architecture.md](docs/architecture.md#ported-from-scf-ai-presence)). The two repositories are independent. SCF-AI-Presence is unchanged.

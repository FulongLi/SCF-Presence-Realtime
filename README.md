# SCF Presence Realtime

SCF Presence Realtime is a native realtime voice AI with a living visual body. It connects directly to a realtime conversational model over WebRTC and reacts physically to listening, thinking and speaking. The AI can also choose to show information with its particle body, using native function tools.

The particle sphere is the interface. There is no chat window, waveform or dashboard. The AI hears you, thinks, answers in its own voice, and sometimes takes a brief visual shape. That can be a person, a car, a product, a map, the terrain of a real region, or a time, number, word or symbol. Then it returns to the sphere.

SCF supports **open 2D and 2.5D visual expression**: the AI isn't limited to a fixed set of icons. A Visual Resolver finds or builds an appropriate picture or height field for whatever is worth seeing. **True 3D object models are intentionally deferred** (see [the future 3D direction](docs/architecture.md#future-true-3d)).

```text
sphere  →  temporary visual expression  →  sphere
```

## Architecture

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
- **The server** has one job: turn the permanent `OPENAI_API_KEY` into a short-lived client secret bound to a fixed session config.

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

- `OPENAI_API_KEY` is read only by the server route [`src/app/api/realtime/token/route.ts`](src/app/api/realtime/token/route.ts), which imports `server-only`. It is never bundled into the browser or returned in a response.
- The browser receives only an ephemeral client secret (`ek_…`). The secret lives for 60 seconds, just long enough for the WebRTC SDP exchange with `https://api.openai.com/v1/realtime/calls`.
- Model, voice, instructions, tools and turn detection are fixed on the server when the secret is minted, so the browser cannot change them.
- `.env*` files are git-ignored, except `.env.example`, which contains no values.
- The token route only accepts requests from the app's own origin (plus `SCF_ALLOWED_ORIGINS`). That stops other websites from spending your key through a visitor's browser. It is **not** authentication: any public deployment lets any visitor start sessions billed to your key. Put auth in front of it for anything beyond personal use.

### Configuration (`.env.local`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Standard API key, server-only |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | GA Realtime model |
| `OPENAI_REALTIME_VOICE` | `marin` | Output voice (`marin`, `cedar`, `alloy`, …) |
| `OPENAI_REALTIME_TURN_DETECTION` | `semantic_vad` | `semantic_vad` or `server_vad` |
| `OPENAI_REALTIME_VAD_EAGERNESS` | `auto` | `low`, `medium`, `high` or `auto` (semantic VAD) |
| `OPENAI_REALTIME_TRANSCRIPTION_MODEL` | off | e.g. `gpt-4o-mini-transcribe`, to get user transcripts in `?debug=1` (extra cost) |
| `SCF_SAFETY_ID_SALT` | built-in | Salt for the hashed safety identifier; set a random value in production |
| `SCF_ALLOWED_ORIGINS` | none | Extra origins allowed to request tokens |
| `BRAVE_SEARCH_API_KEY` | off | Optional web-scale image search for `show_image`/`show_portrait`, server-only (see [Visual Resolver](#visual-resolver)) |
| `NEXT_PUBLIC_SCF_DEBUG` | off | `1` enables `?debug=1` in production builds |

Invalid values fall back to the defaults and are never forwarded.

## Native visual tools

The model gets eight function tools (see [`src/realtime/tools/definitions.ts`](src/realtime/tools/definitions.ts)). Two are open. The rest are convenience shapes. There are no per-object tools like `show_car` or `show_mountain`.

| Tool | Arguments | Becomes |
| --- | --- | --- |
| `show_image` | `{ query, intent? }`, intent ∈ portrait, celebrity, object, vehicle, product, reference, map, general | `{ type: "image", query, intent }`. Any person, vehicle, product, object, place, map or reference image, found through the image provider chain. |
| `show_terrain` | `{ region, style? }`, style ∈ terrain, topography, relief, heightmap | `{ type: "terrain", region, style }`. Real elevation of any geocodable place as a 2.5D relief. |
| `show_clock` | `{ time?: "HH:MM" }` | `{ type: "clock", time? }`. With no time it shows the local time, and the result tells the model that time. |
| `show_portrait` | `{ person }` | `{ type: "portrait", person }`. The same image chain with the portrait intent: Wikipedia first, then other sources. |
| `show_number` | `{ value }` | `{ type: "number", value }`, e.g. `42%`, `23°C`, `£28,000` |
| `show_text` | `{ value }` | `{ type: "text", value }`, one short word or label |
| `show_symbol` | `{ symbol }` | `{ type: "symbol", value }`: check, cross, heart, star, question, exclamation, arrow-up/down/left/right, plus, minus |
| `return_to_sphere` | `{}` | `{ type: "sphere" }` |

Every call maps onto the **same `VisualAction` schema** and passes strict `validateVisualAction()` checks before reaching the `VisualActionController`. Those checks are allowlists, length limits, no markup, URLs or control characters, and no unknown fields. Open queries are only ever used as search text.

Lifecycle: `response.function_call_arguments.delta` (assembled per `call_id`) → `…arguments.done` → validate and execute locally, while the voice keeps playing → `conversation.item.create { type: "function_call_output" }` with a concise result. Examples: `{"ok":true,"status":"displayed"}`, `{"ok":true,"status":"forming"}` (still downloading after 1.5 s), `{"ok":false,"status":"image-not-found"}`, `{"ok":false,"status":"terrain-unavailable"}`. If a response only called tools and never spoke, SCF sends `response.create` so the model can continue. A response that already spoke gets no follow-up, so the model never narrates its tools.

## Visual Resolver

```text
tool call ─► validated VisualAction ─► Visual Resolver ─► VisualTarget ─► particle target ─► sphere → visual → sphere
                                        │
                                        ├─ glyphs   clock · number · text · symbol  (canvas)
                                        ├─ images   wikipedia · commons · openverse · web(optional)  → Raster2DTarget
                                        └─ terrain  geocoder → AWS elevation tiles (→ relief image)  → HeightFieldTarget
```

- **Open image retrieval.** Providers are tried in an order that suits the intent. For each one, candidates are ranked deterministically (relevance, size, aspect, format, source, off-topic penalty), the best ones are downloaded safely, and the first image that downloads and decodes cleanly is used. If a provider is down, returns nothing, or its downloads fail, the next one takes over. No lists of supported objects or people exist anywhere.
- **Portraits** are no longer tied to Wikipedia. Wikimedia is one provider among several, and portraits get a head-and-shoulders crop.
- **Normalization.** Guarded fetch, then format validation by `Content-Type` and magic bytes (JPEG/PNG/WebP), byte and dimension bounds, and decoding. Then an intent-aware crop (portrait band, or plain-background trim for objects) and a resize to at most 300 px.
- **Terrain (2.5D).** The region is geocoded with OpenStreetMap Nominatim, which returns its outline, with Photon as fallback. Real elevation in metres comes from keyless AWS Terrain Tiles (≤ 16 tiles). The outline masks the grid, the sea is removed, and heights are normalized between percentiles. Particles form a tilted relief surface: mountains rise, valleys sink, hillshaded in the chosen style.
- **Optional key.** With `BRAVE_SEARCH_API_KEY`, a server route adds web-scale image search. It downloads only from Brave's thumbnail host and returns only image bytes. The key never reaches the browser. Without it, everything else works keyless.

Details, guardrails and the future 3D extension point: [docs/architecture.md → Visual Resolver](docs/architecture.md#visual-resolver-open-2d-and-25d-visuals).

## Privacy

| Data | Where it goes |
| --- | --- |
| Microphone audio | Straight to the OpenAI Realtime API over WebRTC, only while a session is open |
| Assistant audio | OpenAI → your browser |
| Particle and audio analysis (VAD, emphasis, spectrum) | Stays in the browser |
| Visual Action execution | Stays in the browser |
| Image lookup (`show_image`, `show_portrait`) | Only the query text, sent anonymously (no cookies, no referrer) to Wikipedia/Wikimedia Commons and Openverse, and only when a visual is requested. Images are downloaded from their image hosts. With `BRAVE_SEARCH_API_KEY`, the query also goes through SCF's server to Brave Search. |
| Terrain lookup (`show_terrain`) | Only the region name, to OpenStreetMap Nominatim (with the page origin, per its usage policy) or Photon. Elevation tiles come from AWS Open Data. |
| Transcripts (optional) | Kept in page memory for `?debug=1`, never stored or sent anywhere |
| Installation id | A random id in `localStorage`. The server sends only a salted SHA-256 of it to OpenAI as `OpenAI-Safety-Identifier`. |

The server stores nothing: no database, no conversation, no transcripts, no audio. After 10 minutes without conversation the session ends and the microphone is released. Tap to resume.

**Safety identifier.** OpenAI recommends a stable, privacy-preserving per-user identifier, set server-side, when minting ephemeral Realtime secrets. There are no accounts, so SCF hashes the anonymous installation id with `SCF_SAFETY_ID_SALT` into `scf-<40 hex>`. OpenAI can link sessions from the same browser installation, but it gets no personal information, and the value cannot be linked across deployments that use different salts.

## Development

- `npm run dev`, then open `/?debug=1` for the development panel. It shows:
  - Realtime status: WebRTC/data channel state, model, voice, session duration, response count, token usage.
  - Conversation state: OpenAI VAD, response active, interruptions.
  - Audio: user and assistant amplitude, spectrum bands.
  - Tools: last call, arguments, result.
  - Visual resolver: query or region, intent or style, provider fallback chain with per-provider outcome and latency, selected provider and source, source type, target type, raster or height-field size, normalized height range and real elevation range, fetch and resolver latency, final status.
  - Presence: mode, visual phase, current visual, quality tier.
  - The in-memory transcript.
- It also has one-click manual tests through the real tool executor: portrait Nikola Tesla; images Tesla Model Y, Taylor Swift and a futuristic concept car; terrain Wales and United Kingdom; clock, text, number, symbol, sphere. It adds free-form `show_image`/`show_terrain` inputs, direct Visual Actions, and a local file as portrait, object or heightmap. That way body and resolver problems can be separated from Realtime problems. It never shows the API key, the ephemeral secret or any provider key.
- The debug panel is not in production builds unless `NEXT_PUBLIC_SCF_DEBUG=1`.

## Testing

```bash
npm run lint
npm run typecheck
npm test        # 127 deterministic unit tests, no network, no credentials
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
- **Server:** the ephemeral secret request (GA session shape, no beta header), the hashed safety identifier, configuration fallbacks, origin and body checks, upstream error mapping, and the key never appearing in a response.

The end-to-end check against OpenAI is a manual checklist: [docs/smoke-test.md](docs/smoke-test.md). CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, typecheck, tests and build with no API key.

## Deployment

The app is a Next.js app plus one small server route, so it needs a host that runs Next.js server routes. A static export (e.g. GitHub Pages) won't work.

- **Vercel** (simplest): import the repository, set `OPENAI_API_KEY` (and optionally the other variables) under Project → Settings → Environment Variables, then deploy. The token route runs on the Node.js runtime.
- **Netlify, Cloudflare (OpenNext) or any Node host:** `npm run build && npm start` with the same environment variables.
- Serve over **HTTPS**, which the microphone requires. If you use a custom domain behind a proxy that rewrites `Host`, add it to `SCF_ALLOWED_ORIGINS`.
- Set `SCF_SAFETY_ID_SALT` to a random secret.

No database, queue, WebSocket server or extra infrastructure is needed.

## Current limitations

- **WebGPU is required for the body.** Without it, a notice appears but voice still works. There is no WebGL fallback yet.
- **No authentication.** Anyone who can load a public deployment can start sessions on your key. See [API key handling](#api-key-handling).
- **Echo:** SCF relies on the browser's echo cancellation and OpenAI's turn detection. On loud speakers without headphones, the assistant may occasionally interrupt itself.
- **Autoplay:** if the browser blocks audio without a gesture, the page asks for one tap ("Tap anywhere to begin") rather than letting the AI talk silently.
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

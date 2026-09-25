# Manual smoke test (needs a real OpenAI API key)

Unit tests mock every Realtime and WebRTC surface. This checklist is the one end-to-end test that talks
to OpenAI. It uses your API key and is billed to your account.

## Setup

```bash
cp .env.example .env.local   # then set OPENAI_API_KEY=sk-...
npm install
npm run dev
```

Open <http://localhost:3000/?debug=1> in a desktop browser with WebGPU (current Chrome, Edge or Safari).
`localhost` counts as a secure context, so microphone access works without HTTPS.
The debug panel is optional. It shows what the body is doing and why.

## 1. Voice loop

| Step | Expected |
| --- | --- |
| Open the page | The particle sphere appears and breathes slowly. The "Talk with the presence" card is shown. |
| Click **Allow microphone**, accept the browser prompt | The card disappears. Debug shows `phase connected`, `webrtc connected · data channel open`, the model (`gpt-realtime-2.1` by default) and the voice. |
| Say "Hello" | While you speak, the body gathers inward, calms and brightens slightly (`listening`). |
| Stop talking | Interior turbulence and rotation start (`thinking`) until audio arrives. |
| The assistant answers audibly | Speaking motion follows the real voice: radial tufts per spectrum band and accents on stressed syllables. Debug `assistant amplitude` and `bands` move. |
| Silence | The body returns to idle breathing. |

## 2. Native tool: clock

Say: *"What time is it?"*

Expected:

- The model calls `show_clock` (debug → tools: `last call show_clock`, result `{"ok":true,"status":"displayed","shown":"HH:MM",…}`).
- The particles form the current local time, and the assistant says the time.
- After about 7 s the body returns to the sphere.

## 3. Native tool: portrait

Say: *"What does Nikola Tesla look like?"*

Expected:

- The assistant starts talking, and the model calls `show_portrait` with `{"person":"Nikola Tesla"}`.
- The particles form Tesla's portrait (downloaded from Wikimedia) while the voice continues.
- While the portrait is formed, speech motion is only a subtle shimmer, and the image stays legible.
- After about 14 s the body returns to the sphere.

## 3b. Open visuals: images and terrain

| Say | Expected |
| --- | --- |
| *"Show me a Tesla Model Y."* | `show_image {"query":"Tesla Model Y","intent":"vehicle"}`. Debug → visual resolver: `wikipedia: selected`, target `raster2d`. The particles form a recognizable car (object sampling: the car, not its background). The body returns to the sphere after about 12 s. |
| *"What does Taylor Swift look like?"* | `show_portrait` or `show_image` with a portrait/celebrity intent. If the first provider fails, the chain shows the fallback (e.g. `wikipedia: no results → openverse: selected`). A portrait forms. |
| *"Show me a cool concept car."* | `show_image` with a reference intent, typically from Openverse. |
| *"Show me the terrain of Wales."* | `show_terrain {"region":"Wales"}`. Debug: `aws-terrain-tiles … · nominatim: selected`, target `heightfield`, normalized `0.00–1.00`, roughly `0–900 m` (summits average down at grid resolution). The particles form Wales' outline as a tilted relief: Snowdonia and the Brecon Beacons clearly rise. Sphere after about 14 s. |
| *"Show me the topography of the UK."* | `show_terrain {"region":"United Kingdom","style":"topography"}`. Great Britain, Northern Ireland and the islands as relief with contour bands; the Highlands rise highest. |
| *"What time is it?"* / *"Show 42%."* / *"Show a check."* | `show_clock`, `show_number` and `show_symbol` still work as before. |

Without a microphone or model, **debug → tools** runs the same cases directly: *portrait: Nikola Tesla*, *image: Tesla Model Y*, *image: Taylor Swift*, *image: concept car*, *terrain: Wales*, *terrain: United Kingdom*, and so on.

## 4. Barge-in

Ask for something long ("Tell me the history of the telephone"), then talk over the answer.

Expected:

- The assistant stops within a fraction of a second, with no button press.
- The body switches straight from speaking to listening.
- Debug `interruptions` increases by one.

## 5. Failure paths (optional)

| Action | Expected |
| --- | --- |
| Remove `OPENAI_API_KEY` and restart | A short notice says the server has no API key, with a **Try again** button. There is no crash. |
| Ask to see a portrait of a fictional person | The tool result is `portrait-not-found`, the body stays a sphere, and the conversation continues. |
| Ask for the terrain of a made-up place | `region-not-found`; the body stays a sphere. |
| Block `s3.amazonaws.com` in DevTools → Network request blocking, then ask for terrain | The chain shows `aws-terrain-tiles: network`, then `relief-image`. You get a brightness-based relief, or `terrain-unavailable`. The voice is unaffected. |
| Turn Wi-Fi off for about 10 s mid-session | A "Reconnecting…" notice appears and speaking/thinking stop. After at most 3 bounded attempts, either the session resumes (as a new conversation) or a retry notice appears. |
| Block the microphone in site settings and reload | A one-line notice explains how to allow it. |
| Debug → **disconnect** | The body goes idle, and only one session is ever created (check the Network tab for `/v1/realtime/calls`). |

## Isolating body problems from Realtime problems

The debug panel can drive the body without OpenAI:

- **tools**: runs the same `ToolExecutor` the Realtime function calls use (the manual acceptance set, plus free-form `show_image`/`show_terrain`).
- **visual resolver**: the provider fallback chain, sources, target sizes, height ranges and latencies of the last visual.
- **visual actions (direct)**: submits Visual Actions straight to the controller (clock, 15:42, 42%, Hello, a symbol, a portrait or a local photo).
- **presence**: forces idle, listening, thinking or speaking, sends a focus impulse, or plays synthetic speech through the real speaking pipeline.

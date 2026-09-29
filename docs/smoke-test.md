# Manual smoke test (needs a real OpenAI API key)

Unit tests mock every Realtime, GPT-Live and WebRTC surface. This checklist is the one end-to-end test that
talks to OpenAI. It uses your API key and is billed to your account. Run sections 1–5 with the Realtime
backend (the default, or `/?voice=realtime&debug=1`), then section 6 with GPT-Live.

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

## 6. GPT-Live (`/?voice=live&debug=1`, or `SCF_VOICE_BACKEND=live`)

Same key, no other setup. Debug → **voice backend** should show `backend live`, `live model gpt-live-1 · backend model gpt-5.6-terra`, a `live_…` session id after `session.started`, and the connect time.

| Say / do | Expected |
| --- | --- |
| *"Hello."* | A natural GPT-Live voice. Listening while you speak, speaking while it answers (from the real audio). `voice duration` grows. |
| *"What time is it?"* | `delegations 1`, `function calls 1` (`show_clock`), `continuations 1`; the particle clock forms and the voice says the time. Timings show `delegation → call` and `tool result → audio`. |
| *"Show me Tesla Model Y."* | The backend selects `show_image`; the resolver trace is the same as with Realtime; a particle car forms. |
| *"Show me the terrain of Wales."* | `show_terrain`, the same height-field path. |
| Talk over a long answer | GPT-Live yields naturally. A short "mm-hmm" should not flip the body out of speaking; when the voice actually stops under you, the body switches to listening and `full-duplex cuts` increases. |
| Debug → switch **Realtime** ↔ **GPT-Live** mid-session | The old session closes (`last close close_requested` with confirmed usage for Live), the other backend connects on the same microphone without a new permission prompt, the body stays alive, and `?voice=` in the URL follows the choice. |
| Chinese / English | Speak Chinese, then English: the voice follows your language. |

## 7. Local brand asset: Spirit Connect logo

Put the real logo at `public/assets/brand/spirit-connect-logo.svg` first.

| Say / do | Expected |
| --- | --- |
| Debug → tools → **local asset: Spirit Connect logo** | Without OpenAI. Resolver trace: `1. local-assets: selected (alias match: spirit-connect-logo)`, `provider local-assets`, `source /assets/brand/spirit-connect-logo.svg`, `target raster2d/logo`. A crisp particle logo with no background rectangle, then back to the sphere. |
| *"Show me the Spirit Connect logo."* (both backends) | `show_image` with a Spirit Connect query → the same trace; no Wikipedia/Openverse/web step appears. |
| *"Show our company logo."* | The same local logo. |
| Temporarily rename the file, then ask again | `image-unavailable`, trace `local-assets: unavailable (http-404); no external fallback`; no other logo is shown. |

## 8. Visual Form Packs (both backends)

| Say / do | Expected |
| --- | --- |
| Debug → **visual forms** → each Tao, Astronomy and Astrology button | Without OpenAI. Trace: `1. visual-forms: constructed (ink \| star-map \| star-glyph, no network)`, `provider visual-forms`, `target raster2d/ink` or `points/celestial · layout N points, M strokes`, fetch 0 ms. Each form gathers from the sphere, holds about 10 s and returns. |
| *"Show me yin yang."* | `show_form` (not `show_image`), result `shown: "Yin-yang ☯ (太极)"`. A bright left fish and a sparse, dim right one with an S between them, a dot in each head, a fine rim; it turns slowly clockwise. |
| *"Show me the Eight Trigrams."* / *"Show me the later heaven bagua."* | `tao.bagua`: Qian ☰ at the top, Kun ☷ at the bottom (Later Heaven: Li ☲ at the top, Kan ☵ at the bottom), a small yin-yang in the middle, turning very slowly. |
| *"Show me Qian."* / *"Show me 坎."* | Three whole lines / broken, whole, broken; upright and still. |
| *"Show me Orion."* / *"Show me the Pleiades."* | Star maps: Betelgeuse upper left, Rigel lower right, the belt, faint figure lines; the Pleiades as a small cluster with no lines and a faint glow. |
| *"Show me the Aries zodiac sign."* / *"I'm a Leo, show me my sign."* / *"Show me the Leo constellation."* | ♈ and ♌ drawn in star dust with small stars at the stroke ends; the constellation request shows the star map instead (`astronomy.leo`). |
| Debug → free-form `show_form` with `Andromeda Galaxy` | `form-not-found`; the body is not touched. |

## 9. Aion: identity, greeting, body (both backends)

1. Fresh load, allow the microphone, stay quiet. Once connected, Aion greets once ("Hi, I'm Aion. You can just talk to me naturally…") and, in the figure body, raises a hand briefly. Debug → Aion shows `greeting sent`. No second greeting after **reconnect** or a backend switch.
2. Reload and start talking as soon as it connects: no scripted greeting (`greeting suppressed`).
3. "Who are you?" → Aion, an interactive AI presence created by Spirit Connect. "Who created you?" → Spirit Connect, led by Fulong. "What is Intelligent Presence?" → the system that gives it a voice and visual body.
4. "你是谁？" → a natural Chinese answer with the same names. Switch back to English: it follows.
5. "I don't know what to do" / "你能做什么？" → one or two sentences with a few real examples, no feature list.
6. "Take a human form" → the sphere re-forms as the Particle Figure over about 2 s. Talk: listening (slight lean and tilt), a nod when you stop, stillness while thinking, a slight hand lift while speaking. Nothing waves continuously.
7. "Show me Orion" in the figure → the figure dissolves into Orion, holds, and re-forms as the figure (not the sphere).
8. "Go back to the sphere" / "回到球体" → the sphere returns.
9. Without the model: debug → Aion → Figure, each state button, Figure → Orion → Figure, Figure → Yin Yang → Figure, greet, onboarding.

## Isolating body problems from model problems

The debug panel can drive the body without OpenAI:

- **tools**: runs the same `ToolExecutor` the Realtime and GPT-Live function calls use (the manual acceptance set including the local Spirit Connect logo, plus free-form `show_image`/`show_terrain`).
- **visual forms**: the same executor with `show_form`: representative Tao, Astronomy and Astrology buttons, every registered form in a picker, and a free-form name + variant.
- **visual resolver**: the provider fallback chain, sources, target sizes, height ranges and latencies of the last visual.
- **visual actions (direct)**: submits Visual Actions straight to the controller (clock, 15:42, 42%, Hello, a symbol, a portrait or a local photo).
- **presence**: forces idle, listening, thinking or speaking, sends a focus impulse, or plays synthetic speech through the real speaking pipeline.

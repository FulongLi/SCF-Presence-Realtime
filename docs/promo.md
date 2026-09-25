# The SCF Presence film

A ~61-second promotional film, performed live by the product itself: the same particle runtime,
PresenceEngine, native tool calls, ToolExecutor, VisualActionController, Visual Resolver and local brand
asset as `/`. Nothing in it is pre-rendered or re-drawn.

```text
nothing → particles → a body → it sees (Nikola Tesla) → information becomes form (the United Kingdom)
        → it feels (🎉) → everyday (18:42) → who made it (Spirit Connect) → it returns to itself
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run promo` | Starts the dev server and prints the film's URL, <http://localhost:3000/promo> |
| `npm run promo:prepare` | Records the dialogue once with OpenAI text-to-speech into `public/promo/audio/` (needs `OPENAI_API_KEY`) |
| `npm run promo:prepare -- --check` | Verifies the recorded lines match the script and fit the timeline (no API calls) |
| `npm run promo:render` | Builds the app, renders the film in headless Chrome and encodes `output/scf-presence-promo-1080p.mp4` |
| `npm run promo:check` | Both checks: dialogue assets, then review stills and a 2-second encode verified by decoding |

**Final render, from a clean checkout:**

```bash
npm install
npm run promo:prepare      # once; OPENAI_API_KEY in .env.local or the environment
npm run promo:render       # → output/scf-presence-promo-1080p.mp4
```

Requirements: Node 22, Google Chrome (the capture uses its real WebGPU; pass `--chrome <path>` for another
Chromium) and ffmpeg (`FFMPEG_PATH`, `ffmpeg` on the PATH, or the bundled `ffmpeg-static` package that
`npm install` fetches). The film needs network access while it prepares (Wikipedia, OpenStreetMap
Nominatim, AWS Terrain Tiles), never while it plays.

`promo:render` options: `--master` (also a ProRes 422 HQ + 24-bit PCM `.mov`), `--no-subtitles` (a clean
version), `--stills [auto|t1,t2,…]` (PNG stills of key moments for review, into `output/stills`),
`--audio-only` (the soundtrack, its loudness and a spectrogram), `--url <base>` (use a running server),
`--no-build`, `--headed`, `--allow-missing-dialogue`.

## Watching it

Open `/promo`. Before playback there is only the black frame, *SCF Presence* and **Play film**; the film
prepares first ("Preparing Presence…") and cannot start until every scene's visual is resolved.

- **Space** play / pause · **Esc** pause and show controls · **F** fullscreen · **M** mute · **C** subtitles
- The frame is always 16:9 (1920×1080 composition), letterboxed in black at any window size.
- The cursor hides while the film plays; **Replay** appears only once it has fully finished.
- Leaving fullscreen with Esc, or switching tabs, pauses the film.
- `?subtitles=0` starts without subtitles; `?tier=0…4` fixes the particle count (default: the device's
  ceiling, fixed for the whole film, never adapted mid-film).
- With `prefers-reduced-motion`, the pre-roll says the film is made of slow continuous motion and plays it
  as designed rather than silently altering it.

## How it works

```text
src/promo/
  script.ts        the film as authored: copy, dialogue, voices, the five tool calls, beat timing
  timeline.ts      compiles the script (+ recorded line lengths) into the master timeline
  birth.ts         the opening formation plan (seeded)          particle/formation.ts: its GPU path
  director.ts      PromoDirector: cues → real tool calls, conversation hints, voice envelopes, FilmLook
  session.ts       one performance: PresenceEngine + VisualActionController + ToolExecutor + director
  preload.ts       resolves every scene through the real Visual Resolver; loads the dialogue
  framing.ts       presentation-only framing (the portrait's soft oval edge)
  camera.ts        slow staging poses (birth, terrain, outro)
  audio.ts         procedural sound design + mix, scheduled on any BaseAudioContext
  voiceAnalysis.ts recorded lines → the product's loudness and 16 spectrum bands, per frame
  clock.ts         the master clock (the audio clock while playing)
  player.ts        FilmPlayer: live playback and frame-exact export
  PromoExperience.tsx, overlays/, styles/   the /promo page
```

- **The body.** `/promo` creates the product's particle runtime with opt-in options: an external frame
  loop, a fixed quality tier, no pointer interaction, a stage camera and a *formation*. `/` passes none of
  them and is unchanged.
- **Birth.** Every grain of the ordinary body gets a seeded plan (where it appears, when, its flight). It
  rises from below, bends continuously toward its own rest place with a shared swirl, and in the last
  fifth of its flight the body's own physics captures it. Once the last grain arrives, every particle is
  exactly where the normal sphere holds it — the same body, not a second system — and the idle breathing
  simply continues. A soft focus pulse (the product's own acoustic-focus response) marks completion.
- **Scenes.** Each expression is a native tool call (`show_portrait`, `show_terrain`, `show_emoji`,
  `show_clock`, `show_image`) sent through the real `ToolExecutor` to the real `VisualActionController`,
  and released with `return_to_sphere`. Before playback, `preload.ts` resolves the same actions with the
  real Visual Resolver (checking that the terrain is real elevation and the logo is the local
  `/assets/brand/spirit-connect-logo.svg`), and the controller is given those targets from memory, so
  playback never waits on the network and can never show a substitute. A failure stops the film.
- **Presence.** The director is the engine's conversation source and microphone: the user's lines make the
  body listen (following the recorded voice's loudness), requests make it think briefly, and the
  assistant's recorded lines drive speaking through the same loudness and spectrum analysis as the live
  assistant track.
- **Determinism.** Everything is a function of film time: the timeline, the seeded birth, the seeded sound
  plan, the offline-analysed voices. Playback follows the audio clock; export steps frames at exactly
  `i / 60` s, renders the soundtrack offline with the same Web Audio graph, and pipes lossless frames to
  ffmpeg.

## Changing the film

- **Copy:** `COPY` in `src/promo/script.ts` (the only on-screen editorial lines).
- **Dialogue:** `DIALOGUE` (subtitle text, spoken text, delivery direction), voices in `VOICE_MODEL`. Then
  `npm run promo:prepare` re-records only the lines that changed.
- **Timing:** `TIMING` in `script.ts` (holds, morph durations, pauses, fades). The birth's shape is `BIRTH`
  in `birth.ts`; camera poses in `camera.ts`; sound levels in `MIX` (`audio.ts`). Lines are timed from
  their recordings, so the film re-flows when a line changes length. `npm test` checks the result.
- **Visuals:** `VISUALS` (the tool calls) and `VISUAL_SOURCES` (where each must come from).

## Assets

- `public/promo/audio/*.wav` + `manifest.json`: the recorded dialogue (mono, trimmed, level-matched). The
  manifest records each line's words, voice and a hash of how it was made; a line whose words no longer
  match the script is treated as missing, never played. The voices are AI-generated (OpenAI
  text-to-speech); disclose that where the film is published.
- Music and sound effects are procedural (Web Audio, seeded): no licensed music or samples.
- `output/` (git-ignored): the render, its soundtrack WAV, a JSON report (sources, loudness, bitrate),
  and review stills.

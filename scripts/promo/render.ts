/**
 * npm run promo:render — exports the SCF Presence film from the real runtime.
 *
 *   next build → next start → headless Chrome (real WebGPU) → /promo?render=1
 *     → preload (real Visual Resolver) → offline soundtrack (48 kHz)
 *     → frame i at t = i / 60, captured exactly → ffmpeg (H.264 + AAC, optional ProRes master)
 *
 * Options:
 *   --out <file>               default output/scf-presence-promo-1080p.mp4
 *   --master                   also write a ProRes 422 HQ + 24-bit PCM master (.mov)
 *   --no-subtitles             render without subtitles
 *   --stills [auto|t1,t2,…]    only capture PNG stills (key moments, or seconds) into output/stills
 *   --check                    pipeline check: stills + a 2-second encode, verified by decoding
 *   --audio-only               render just the soundtrack (WAV), its loudness and a spectrogram
 *   --url <base>               use a running server instead of building and starting one
 *   --no-build                 start the existing production build without rebuilding
 *   --allow-missing-dialogue   render even if the dialogue has not been prepared (writes a -no-dialogue file)
 *   --headed                   show the capture browser
 *   --chrome <path>            Chrome/Chromium executable (default: installed Google Chrome)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { ROOT, fail, ffmpegEncoders, findFfmpeg, freePort, megabytes, parseArgs, run, seconds, startServer } from "./lib";
import type { PreparedReport } from "../../src/promo/player";
import type {} from "../../src/promo/PromoExperience"; // window.__scfPromo

const args = parseArgs(process.argv.slice(2));
const OUTPUT = path.join(ROOT, "output");
const stillsArg = args.string("stills") ?? (args.has("stills") ? "auto" : undefined);
const check = args.has("check");
const subtitles = !args.has("no-subtitles");
const started = Date.now();

async function main() {
  const ffmpeg = findFfmpeg();
  const stillsOnly = stillsArg !== undefined && !check;
  const audioOnly = args.has("audio-only");
  if (!ffmpeg && !stillsOnly) fail("ffmpeg was not found. Install it (e.g. `brew install ffmpeg`), set FFMPEG_PATH, or run `npm install` to get the bundled ffmpeg-static.");
  mkdirSync(OUTPUT, { recursive: true });

  // 1 · The app.
  let base = args.string("url");
  let server: { stop(): void } | null = null;
  if (!base) {
    if (!args.has("no-build")) { console.log("▸ Building the production app…"); run(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "build", "--webpack"]); }
    const port = await freePort(4317);
    const started = await startServer(port);
    base = started.url; server = started;
  }
  const stop = () => server?.stop();
  process.on("exit", stop);

  // 2 · The browser: real GPU, sRGB output, 1920×1080 at 1 CSS pixel per pixel (the canvas supersamples 2×).
  const browser: Browser = await chromium.launch({
    channel: args.string("chrome") ? undefined : "chrome",
    executablePath: args.string("chrome"),
    headless: !args.has("headed"),
    args: ["--force-color-profile=srgb", "--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--enable-unsafe-webgpu"],
  }).catch(error => fail(`Chrome could not be started (${error instanceof Error ? error.message.split("\n")[0] : error}). Install Google Chrome or pass --chrome <path>.`));
  const page: Page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const problems: string[] = [];
  page.on("pageerror", error => problems.push(`page error: ${error.message}`));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) problems.push(message.text()); });
  const url = `${base}/promo?render=1${subtitles ? "" : "&subtitles=0"}`;
  console.log(`▸ Opening ${url}`);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__scfPromo), null, { timeout: 60_000 });
  console.log("▸ Preparing Presence (resolving every scene through the real Visual Resolver)…");
  const report: PreparedReport = await page.evaluate(() => window.__scfPromo!.ready).catch(error => {
    fail(`the film could not be prepared: ${error instanceof Error ? error.message : error}${problems.length ? `\n${problems.join("\n")}` : ""}`);
  });
  for (const visual of report.visuals) console.log(`  ${visual.id.padEnd(8)} ${visual.kind.padEnd(18)} ${visual.provider} ${visual.source ? `· ${visual.source.slice(0, 70)}` : ""}`);
  console.log(`  ${report.frames} frames · ${report.duration.toFixed(2)} s · ${report.fps} fps · ${report.particles.toLocaleString("en")} particles (tier ${report.tier})`);
  const noDialogue = report.missingDialogue.length > 0;
  if (noDialogue) {
    console.warn(`  ⚠ dialogue not prepared: ${report.missingDialogue.join(", ")}`);
    if (!stillsOnly && !check && !audioOnly && !args.has("allow-missing-dialogue")) {
      fail("Dialogue audio is missing. Run `npm run promo:prepare` (needs OPENAI_API_KEY), or pass --allow-missing-dialogue for a render without voices.");
    }
  }

  const cdp: CDPSession = await page.context().newCDPSession(page);
  const capture = async () => Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, fromSurface: true })).data, "base64");
  let rendered = 0;
  const renderTo = async (index: number, present: boolean) => {
    // Frames before the one we want are simulated without waiting for presentation.
    if (index > rendered) await page.evaluate(async ([from, to]) => { for (let i = from; i < to; i++) await window.__scfPromo!.renderFrame(i, false); }, [rendered, index] as const);
    await page.evaluate(([i, p]) => window.__scfPromo!.renderFrame(i, p), [index, present] as const);
    rendered = index + 1;
  };

  // 3 · Stills (review, and the pipeline check).
  if (stillsArg !== undefined || check) {
    const moments = await page.evaluate(() => window.__scfPromo!.moments());
    const wanted = stillsArg && stillsArg !== "auto"
      ? stillsArg.split(",").map(Number).filter(Number.isFinite).map(t => ({ label: `t${t.toFixed(2)}`, t }))
      : moments;
    const directory = path.join(OUTPUT, "stills");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const frames = [...new Map(wanted.map(m => [Math.round(m.t * report.fps), m.label])).entries()].sort((a, b) => a[0] - b[0]);
    for (const [index, label] of frames) {
      await renderTo(Math.min(index, report.frames - 1), true);
      const file = path.join(directory, `${String(index).padStart(4, "0")}-${label}.png`);
      writeFileSync(file, await capture());
      console.log(`  still ${(index / report.fps).toFixed(2).padStart(6)} s  ${path.relative(ROOT, file)}`);
    }
    if (!check) { await finish(browser, stop, problems); return; }
    // A fresh page for the encode check: the film always renders from frame 0.
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__scfPromo), null, { timeout: 60_000 });
    await page.evaluate(() => window.__scfPromo!.ready);
    rendered = 0;
  }

  // 4 · The soundtrack, rendered offline in the page by the same graph that plays live.
  console.log("▸ Rendering the soundtrack offline…");
  const wav = Buffer.from(await page.evaluate(() => window.__scfPromo!.renderAudio()), "base64");
  const suffix = noDialogue ? "-no-dialogue" : subtitles ? "" : "-clean";
  const defaultOut = path.join(OUTPUT, check ? "check/scf-presence-promo-check.mp4" : `scf-presence-promo-1080p${suffix}.mp4`);
  const out = path.resolve(ROOT, args.string("out") ?? defaultOut);
  mkdirSync(path.dirname(out), { recursive: true });
  const audioFile = out.replace(/\.mp4$/i, "") + "-audio.wav";
  writeFileSync(audioFile, wav);
  const loudness = measureLoudness(ffmpeg!, audioFile);
  if (loudness) console.log(`  mix: ${loudness.integrated} LUFS integrated · ${loudness.range} LU range · ${loudness.peak} dBTP true peak`);
  if (args.has("audio-only")) {
    const picture = audioFile.replace(/\.wav$/, "-spectrogram.png");
    spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-i", audioFile, "-lavfi",
      "showspectrumpic=s=1800x600:legend=1:scale=log:fscale=log:start=20:stop=16000,format=rgb24", picture]);
    console.log(`✓ ${path.relative(ROOT, audioFile)} · ${path.relative(ROOT, picture)}`);
    await finish(browser, stop, problems);
    return;
  }

  // 5 · Frames → ffmpeg.
  const frames = check ? report.fps * 2 : report.frames;
  const encoders = ffmpegEncoders(ffmpeg!);
  const aac = encoders.has("aac_at") ? ["-c:a", "aac_at", "-aac_at_mode", "cbr", "-b:a", "320k"] : ["-c:a", "aac", "-b:a", "320k"];
  const master = args.has("master") && !check ? out.replace(/\.mp4$/i, "") + "-master.mov" : null;
  const color = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const ffArgs = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(report.fps), "-c:v", "png", "-i", "-",
    "-i", audioFile,
    "-map", "0:v", "-map", "1:a", "-t", (frames / report.fps).toFixed(4),
    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
    "-c:v", "libx264", "-preset", check ? "veryfast" : "slow", "-crf", "14", "-tune", "film", "-profile:v", "high", "-level", "4.2",
    "-g", String(report.fps * 2), "-bf", "2", ...color, ...aac, "-ar", "48000", "-movflags", "+faststart", out,
  ];
  if (master) ffArgs.push("-map", "0:v", "-map", "1:a", "-t", (frames / report.fps).toFixed(4),
    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv422p10le",
    "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", ...color, "-c:a", "pcm_s24le", master);
  const encoder = spawn(ffmpeg!, ffArgs, { stdio: ["pipe", "inherit", "inherit"] });
  const encoded = new Promise<void>((resolve, reject) => encoder.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  console.log(`▸ Capturing ${frames} frames → ${path.relative(ROOT, out)}${master ? ` + ${path.relative(ROOT, master)}` : ""}`);
  const captureStarted = Date.now();
  for (let i = 0; i < frames; i++) {
    await renderTo(i, true);
    const png = await capture();
    if (!encoder.stdin.write(png)) await new Promise(resolve => encoder.stdin.once("drain", resolve));
    if (i % 120 === 119 || i === frames - 1) {
      const rate = (i + 1) / ((Date.now() - captureStarted) / 1000);
      process.stdout.write(`\r  ${String(i + 1).padStart(5)} / ${frames} frames · ${rate.toFixed(1)} fps · ${seconds((frames - i - 1) / rate * 1000)} left   `);
    }
  }
  encoder.stdin.end();
  await encoded;
  process.stdout.write("\n");

  // 6 · Verify by decoding, and report.
  const probe = spawnSync(ffmpeg!, ["-hide_banner", "-i", out, "-map", "0:v:0", "-f", "null", "-"], { encoding: "utf8" });
  if (probe.status !== 0) fail(`the output does not decode:\n${probe.stderr}`);
  const stream = /Stream #0:0.*Video: ([^\n]+)/.exec(probe.stderr)?.[1] ?? "";
  const audio = /Stream #0:1.*Audio: ([^\n]+)/.exec(probe.stderr)?.[1] ?? "";
  const size = statSync(out).size;
  const summary = {
    output: path.relative(ROOT, out), master: master ? path.relative(ROOT, master) : null, audio: path.relative(ROOT, audioFile),
    duration: frames / report.fps, frames, fps: report.fps, sizeBytes: size, bitrateMbps: +(size * 8 / (frames / report.fps) / 1e6).toFixed(1),
    video: stream, audioStream: audio, loudness, subtitles, particles: report.particles, tier: report.tier,
    visuals: report.visuals, missingDialogue: report.missingDialogue, renderSeconds: Math.round((Date.now() - started) / 1000),
    problems,
  };
  writeFileSync(out.replace(/\.mp4$/i, "") + "-report.json", JSON.stringify(summary, null, 2) + "\n");
  console.log(`✓ ${summary.output} · ${megabytes(size)} · ${summary.bitrateMbps} Mb/s · ${summary.duration.toFixed(2)} s`);
  console.log(`  video ${stream}`);
  console.log(`  audio ${audio}`);
  if (master) console.log(`  master ${summary.master} · ${megabytes(statSync(master).size)}`);
  await finish(browser, stop, problems);
}

function measureLoudness(ffmpeg: string, file: string) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const summary = result.stderr.split("Summary:").at(-1) ?? "";
  const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1];
  const range = /LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1];
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary.split("True peak:")[1] ?? "")?.[1];
  return integrated ? { integrated: Number(integrated), range: Number(range), peak: peak === "-inf" ? -Infinity : Number(peak) } : null;
}

async function finish(browser: Browser, stop: () => void, problems: string[]) {
  await browser.close();
  stop();
  if (problems.length) {
    console.error(`\n✖ The page reported problems during the render:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Done in ${seconds(Date.now() - started)}.`);
}

void main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)));

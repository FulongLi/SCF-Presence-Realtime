/**
 * npm run promo:prepare — records the film's dialogue once and stores it as local assets.
 *
 * Each line in src/promo/script.ts (DIALOGUE) is spoken by OpenAI text-to-speech (VOICE_MODEL: the user
 * and the assistant have distinct voices; the assistant uses the product's own voice), then trimmed of
 * leading/trailing silence, level-matched and written to public/promo/audio/<line>.wav with a manifest.
 * A line is only regenerated when its words, direction, voice or model change, so playback and renders
 * never call the API. The key is read from OPENAI_API_KEY (environment or .env.local) and is never
 * printed or written anywhere.
 *
 * Options:
 *   --check   verify the prepared assets against the script and the timeline (no API calls)
 *   --force   regenerate every line
 *   --only <line-id,…>   regenerate just these lines
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIALOGUE, LINE_IDS, VOICE_MODEL, type LineId } from "../../src/promo/script";
import { compileTimeline, timelineProblems } from "../../src/promo/timeline";
import type { DialogueManifest } from "../../src/promo/preload";
import { decodeWav, encodeWav, type PcmAudio } from "../../src/promo/wav";
import { PROCESSING, processLine } from "./dialogue";
import { ROOT, fail, parseArgs, readEnvFile } from "./lib";

const args = parseArgs(process.argv.slice(2));
const DIRECTORY = path.join(ROOT, "public/promo/audio");
const MANIFEST = path.join(DIRECTORY, "manifest.json");

const hashOf = (id: LineId) => {
  const line = DIALOGUE[id];
  return createHash("sha256").update(JSON.stringify({
    processing: PROCESSING, model: VOICE_MODEL.model, voice: VOICE_MODEL.voices[line.speaker], speech: line.speech, direction: line.direction,
  })).digest("hex").slice(0, 16);
};

function readManifest(): DialogueManifest {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")) as DialogueManifest; } catch { return { version: 1, lines: {} }; }
}

async function speak(id: LineId, key: string): Promise<PcmAudio> {
  const line = DIALOGUE[id];
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VOICE_MODEL.model, voice: VOICE_MODEL.voices[line.speaker], input: line.speech,
      instructions: line.direction, response_format: "wav",
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    fail(`OpenAI text-to-speech failed for ${id}: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
  return decodeWav(new Uint8Array(await response.arrayBuffer()));
}

function check(manifest: DialogueManifest) {
  const problems: string[] = [];
  const durations: Partial<Record<LineId, number>> = {};
  for (const id of LINE_IDS) {
    const entry = manifest.lines[id];
    const file = path.join(DIRECTORY, `${id}.wav`);
    if (!entry || !existsSync(file)) { problems.push(`${id}: not prepared`); continue; }
    if (entry.hash !== hashOf(id) || entry.speech !== DIALOGUE[id].speech) { problems.push(`${id}: out of date with the script`); continue; }
    const audio = decodeWav(new Uint8Array(readFileSync(file)));
    durations[id] = audio.channels[0].length / audio.sampleRate;
  }
  const timeline = compileTimeline(durations);
  problems.push(...timelineProblems(timeline));
  return { problems, timeline };
}

async function main() {
  mkdirSync(DIRECTORY, { recursive: true });
  const manifest = readManifest();
  if (args.has("check")) {
    const { problems, timeline } = check(manifest);
    console.log(`Film: ${timeline.duration.toFixed(2)} s (${timeline.nominal.length ? `${timeline.nominal.length} lines timed from nominal lengths` : "timed from the recorded lines"})`);
    for (const id of LINE_IDS) console.log(`  ${id.padEnd(20)} ${timeline.durations[id].toFixed(2)} s  ${DIALOGUE[id].text}`);
    if (problems.length) fail(`Dialogue is not ready:\n  ${problems.join("\n  ")}\nRun \`npm run promo:prepare\` with OPENAI_API_KEY set (environment or .env.local).`);
    console.log("✓ Dialogue assets match the script and fit the timeline.");
    return;
  }
  const only = args.string("only")?.split(",").map(s => s.trim()) as LineId[] | undefined;
  for (const id of only ?? []) if (!LINE_IDS.includes(id)) fail(`unknown line "${id}" (lines: ${LINE_IDS.join(", ")})`);
  const stale = LINE_IDS.filter(id => (only ? only.includes(id) : true)
    && (args.has("force") || only || manifest.lines[id]?.hash !== hashOf(id) || !existsSync(path.join(DIRECTORY, `${id}.wav`))));
  if (!stale.length) { console.log("✓ All dialogue lines are prepared and current (use --force to re-record)."); return; }
  const key = process.env.OPENAI_API_KEY || readEnvFile("OPENAI_API_KEY");
  if (!key) {
    fail(`OPENAI_API_KEY is not set. ${stale.length} line(s) need recording: ${stale.join(", ")}.\n`
      + "Set it in .env.local (see .env.example) or run:  OPENAI_API_KEY=sk-… npm run promo:prepare");
  }
  console.log(`Recording ${stale.length} line(s) with ${VOICE_MODEL.model} (user: ${VOICE_MODEL.voices.user}, assistant: ${VOICE_MODEL.voices.assistant})…`);
  for (const id of stale) {
    const processed = processLine(await speak(id, key));
    const file = `${id}.wav`;
    writeFileSync(path.join(DIRECTORY, file), encodeWav(processed, 16));
    const duration = processed.channels[0].length / processed.sampleRate;
    manifest.lines[id] = { file, speech: DIALOGUE[id].speech, voice: VOICE_MODEL.voices[DIALOGUE[id].speaker], duration: +duration.toFixed(3), hash: hashOf(id) };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`  ✓ ${id.padEnd(20)} ${duration.toFixed(2)} s  “${DIALOGUE[id].text}”`);
  }
  const { problems, timeline } = check(manifest);
  if (problems.length) fail(`Prepared, but:\n  ${problems.join("\n  ")}`);
  console.log(`✓ Dialogue prepared. The film runs ${timeline.duration.toFixed(2)} s.`);
  console.log("  The voices are AI-generated (OpenAI text-to-speech); disclose that where the film is published.");
}

void main();

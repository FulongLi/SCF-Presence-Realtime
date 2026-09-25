import type { StagePose } from "../particle/ParticleRuntime";
import { BIRTH_END } from "./birth";
import { POSES, REST_POSE, type CameraMove } from "./camera";
import { COPY, DIALOGUE, FILM, LINE_IDS, TIMING, VISUALS, type ExpressionTiming, type LineId, type Speaker, type TitleId, type VisualId } from "./script";
import { clamp01, spanEnd, type FadeSpan } from "./transitions";

/**
 * The master timeline: the authored script (script.ts) compiled into absolute seconds. Everything the film
 * does — lines, tool calls, returns, titles, subtitles, camera, sound — is read from this one object, so
 * playback and export are the same deterministic sequence.
 */
export const SCENE_IDS = ["birth", "tesla", "terrain", "emoji", "clock", "identity", "outro"] as const;
export type SceneId = typeof SCENE_IDS[number];

export interface Span { start: number; end: number }
export interface SceneCue extends Span { id: SceneId }
export interface LineCue extends Span { id: LineId; speaker: Speaker; text: string }
/** One real visual tool call: sent at `start`, fully formed at `formed`, released at `release`, sphere again at `sphere`. */
export interface VisualCue {
  id: VisualId; tool: string; args: Readonly<Record<string, string>>;
  start: number; formed: number; release: number; sphere: number;
  form: number; return: number;
}
export interface TitleCue extends FadeSpan { id: TitleId; text: string }
export interface PulseCue { at: number; strength: number }

export interface Timeline {
  duration: number;
  fps: number;
  /** The body forms from free particles between these times (formation clock = t − start). */
  birth: Span;
  scenes: SceneCue[];
  lines: LineCue[];
  /** The body considers a request (awaiting its reply or visual). */
  thinking: Span[];
  visuals: VisualCue[];
  titles: TitleCue[];
  pulses: PulseCue[];
  camera: { initial: StagePose; moves: CameraMove[] };
  /** The final fade of everything to black. */
  blackout: { start: number; duration: number };
  /** The line lengths the timeline was compiled with. */
  durations: Record<LineId, number>;
  /** Lines timed from their nominal length because no recording was available. */
  nominal: LineId[];
}

const usable = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0.1 && value < 8;

/** Compiles the film. `recorded` holds the real length of each prepared dialogue line (seconds). */
export function compileTimeline(recorded: Partial<Record<LineId, number>> = {}): Timeline {
  const T = TIMING;
  const durations = {} as Record<LineId, number>;
  const nominal: LineId[] = [];
  for (const id of LINE_IDS) {
    const value = recorded[id];
    if (usable(value)) durations[id] = value;
    else { durations[id] = DIALOGUE[id].nominal; nominal.push(id); }
  }
  const scenes: SceneCue[] = [], lines: LineCue[] = [], thinking: Span[] = [], visuals: VisualCue[] = [];
  const titles: TitleCue[] = [], pulses: PulseCue[] = [], moves: CameraMove[] = [];
  const say = (id: LineId, at: number): LineCue => {
    const cue = { id, speaker: DIALOGUE[id].speaker, text: DIALOGUE[id].text, start: at, end: at + durations[id] };
    lines.push(cue);
    return cue;
  };
  const show = (id: VisualId, at: number, timing: ExpressionTiming): VisualCue => {
    const formed = at + timing.form, release = formed + timing.hold;
    const cue = { id, tool: VISUALS[id].tool, args: VISUALS[id].args, start: at, formed, release, sphere: release + timing.return, form: timing.form, return: timing.return };
    visuals.push(cue);
    return cue;
  };
  /** The frontal push-in while an expression forms and holds, easing back as it returns. */
  const breathe = (cue: VisualCue, settle = true) => {
    moves.push({ start: cue.start, duration: cue.release - cue.start, to: POSES.hold });
    if (settle) moves.push({ start: cue.release, duration: cue.return + 0.6, to: REST_POSE });
  };
  const think = (start: number, end: number) => thinking.push({ start, end });
  const title = (id: TitleId, start: number, fade: { fadeIn: number; hold: number; fadeOut: number }) => {
    const cue = { id, text: COPY[id], start, ...fade };
    titles.push(cue);
    return cue;
  };

  // 1 · The birth of presence: black, particles, a body; then the question.
  pulses.push({ at: BIRTH_END + T.birth.pulse, strength: T.birth.pulseStrength });
  moves.push({ start: 0.8, duration: BIRTH_END - 0.2, to: REST_POSE });
  const question = title("question", BIRTH_END + T.question.after, T.question);
  let cursor = spanEnd(question) + T.firstLine;
  scenes.push({ id: "birth", start: 0, end: cursor });

  // 2 · Seeing: Nikola Tesla.
  let start = cursor;
  const tesla = say("tesla.user", cursor);
  think(tesla.end, tesla.end + T.think);
  const portrait = show("tesla", tesla.end + T.think, T.tesla);
  say("tesla.assistant", portrait.start + T.tesla.speak);
  breathe(portrait);
  cursor = portrait.sphere + T.tesla.rest;
  scenes.push({ id: "tesla", start, end: cursor });

  // 3 · Information becomes form: the United Kingdom, with the only camera move inside a scene.
  start = cursor;
  const request = say("terrain.user", cursor);
  think(request.end, request.end + T.think);
  const terrain = show("terrain", request.end + T.think, T.terrain);
  title("caption", terrain.formed + T.caption.after, T.caption);
  moves.push({ start: terrain.start, duration: T.terrain.form + 1.3, to: POSES.terrain });
  moves.push({ start: terrain.release - 0.2, duration: T.terrain.return + 1.1, to: REST_POSE });
  cursor = terrain.sphere + T.terrain.rest;
  scenes.push({ id: "terrain", start, end: cursor });

  // 4 · Emotion: 🎉.
  start = cursor;
  const relief = say("emoji.user", cursor);
  think(relief.end, relief.end + T.emoji.think);
  const agreed = say("emoji.assistant", relief.end + T.emoji.think);
  const party = show("emoji", agreed.end + T.emoji.after, T.emoji);
  breathe(party);
  cursor = party.sphere + T.emoji.rest;
  scenes.push({ id: "emoji", start, end: cursor });

  // 5 · Everyday intelligence: 18:42.
  start = cursor;
  const time = say("clock.user", cursor);
  think(time.end, time.end + T.clock.think);
  const clock = show("clock", time.end + T.clock.think, T.clock);
  say("clock.assistant", clock.start + T.clock.speak);
  breathe(clock);
  cursor = clock.sphere + T.clock.rest;
  scenes.push({ id: "clock", start, end: cursor });

  // 6 · Identity: Spirit Connect.
  start = cursor;
  const who = say("identity.user", cursor);
  think(who.end, who.end + T.identity.think);
  const maker = say("identity.assistant", who.end + T.identity.think);
  const logo = show("logo", maker.end + T.identity.after, { form: T.identity.form, hold: T.identity.hold, return: T.outro.return });
  breathe(logo, false); // the outro's pullback takes over from the mark
  scenes.push({ id: "identity", start, end: logo.release });

  // 7 · Return to self: the mark releases into the body, the body settles, the titles arrive, black.
  pulses.push({ at: logo.sphere - 0.1, strength: T.birth.returnPulse });
  moves.push({ start: logo.release + 0.3, duration: 4.4, to: POSES.outro });
  const o = T.outro;
  const titleAt = logo.sphere + o.settle;
  const taglineAt = titleAt + o.tagline.after;
  const makerAt = taglineAt + o.maker.after;
  const blackoutStart = makerAt + o.maker.fadeIn + o.breathe;
  const duration = blackoutStart + o.fade + o.black;
  const until = (at: number, fadeIn: number) => ({ fadeIn, hold: duration - at - fadeIn, fadeOut: 0 });
  title("title", titleAt, until(titleAt, o.title.fadeIn));
  title("tagline", taglineAt, until(taglineAt, o.tagline.fadeIn));
  title("maker", makerAt, until(makerAt, o.maker.fadeIn));
  scenes.push({ id: "outro", start: logo.release, end: duration });

  moves.sort((a, b) => a.start - b.start);
  return {
    duration, fps: FILM.fps, birth: { start: 0, end: BIRTH_END }, scenes, lines, thinking, visuals, titles, pulses,
    camera: { initial: POSES.birth, moves }, blackout: { start: blackoutStart, duration: o.fade }, durations, nominal,
  };
}

/** Every problem that would make the timeline impossible to play as authored (empty when sound). */
export function timelineProblems(timeline: Timeline): string[] {
  const problems: string[] = [];
  const finite = (label: string, ...values: number[]) => { if (!values.every(Number.isFinite)) problems.push(`${label}: non-finite time`); };
  const ordered = <S extends Span>(label: string, spans: readonly S[], name: (span: S) => string, gap = 0) => {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      finite(`${label} ${name(span)}`, span.start, span.end);
      if (!(span.end >= span.start)) problems.push(`${label} ${name(span)} ends before it starts`);
      if (span.start < 0 || span.end > timeline.duration + 1e-9) problems.push(`${label} ${name(span)} is outside the film`);
      if (i > 0 && span.start < spans[i - 1].end + gap - 1e-9) problems.push(`${label} ${name(span)} overlaps ${name(spans[i - 1])}`);
    }
  };
  finite("duration", timeline.duration);
  ordered("scene", timeline.scenes, s => s.id);
  if (timeline.scenes[0]?.start !== 0) problems.push("the film does not start with a scene");
  for (let i = 1; i < timeline.scenes.length; i++) {
    if (Math.abs(timeline.scenes[i].start - timeline.scenes[i - 1].end) > 1e-9) problems.push(`scene ${timeline.scenes[i].id} does not follow ${timeline.scenes[i - 1].id}`);
  }
  if (Math.abs((timeline.scenes.at(-1)?.end ?? 0) - timeline.duration) > 1e-9) problems.push("the last scene does not end the film");
  ordered("line", timeline.lines, l => l.id, 0.05);
  ordered("thinking", timeline.thinking, () => "span");
  const visualSpans = timeline.visuals.map(v => ({ ...v, end: v.sphere }));
  ordered("visual", visualSpans, v => v.id, 0.2);
  for (const v of timeline.visuals) {
    finite(`visual ${v.id}`, v.start, v.formed, v.release, v.sphere);
    if (!(v.start < v.formed && v.formed < v.release && v.release < v.sphere)) problems.push(`visual ${v.id} phases are out of order`);
    if (Math.abs(v.formed - v.start - v.form) > 1e-6 || Math.abs(v.sphere - v.release - v.return) > 1e-6) problems.push(`visual ${v.id} durations disagree`);
    // A new expression may only start from the sphere, and never while the body is being born.
    if (v.start < timeline.birth.end) problems.push(`visual ${v.id} starts during the birth`);
  }
  for (const title of timeline.titles) {
    finite(`title ${title.id}`, title.start, title.fadeIn, title.hold, title.fadeOut);
    if (title.start < 0 || spanEnd(title) > timeline.duration + 1e-6) problems.push(`title ${title.id} is outside the film`);
  }
  const caption = timeline.titles.find(title => title.id === "caption");
  const terrain = timeline.visuals.find(v => v.id === "terrain");
  if (caption && terrain && (caption.start < terrain.formed || spanEnd(caption) > terrain.release)) problems.push("the caption must appear on the formed terrain and leave before it does");
  const question = timeline.titles.find(title => title.id === "question");
  if (question && question.start < timeline.birth.end) problems.push("the question appears before the body is formed");
  ordered("camera move", timeline.camera.moves.map(m => ({ start: m.start, end: m.start + m.duration })), () => "move");
  for (const pulse of timeline.pulses) finite("pulse", pulse.at, pulse.strength);
  finite("blackout", timeline.blackout.start, timeline.blackout.duration);
  if (timeline.blackout.start + timeline.blackout.duration > timeline.duration + 1e-9) problems.push("the blackout does not finish before the end");
  return problems;
}

/** The line being heard at time t, if any. */
export function lineAt(timeline: Timeline, t: number): LineCue | null {
  for (const line of timeline.lines) if (t >= line.start && t < line.end) return line;
  return null;
}

/** The film subtitle at time t: the nearest line within its lead-in/tail, with a soft fade. */
export function subtitleAt(timeline: Timeline, t: number): { line: LineCue; opacity: number } | null {
  const { lead, tail, fade } = TIMING.subtitles;
  for (const line of timeline.lines) {
    const from = line.start - lead, to = line.end + tail;
    if (t >= from && t < to) return { line, opacity: Math.min(clamp01((t - from) / fade), clamp01((to - t) / fade)) };
  }
  return null;
}

export const frameCount = (timeline: Timeline) => Math.ceil(timeline.duration * timeline.fps);

"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Controls } from "./overlays/Controls";
import { FilmWords } from "./overlays/FilmWords";
import { FilmPlayer, type FilmElements, type PlayerState, type PreparedReport } from "./player";
import type { TitleId } from "./script";
import styles from "./styles/promo.module.css";

/** The export API the render script drives (`/promo?render=1`). */
export interface PromoRenderApi {
  ready: Promise<PreparedReport>;
  renderFrame(index: number, present?: boolean): Promise<void>;
  renderAudio(): Promise<string>;
  /** Key moments of the film (for review stills). */
  moments(): { label: string; t: number }[];
  /** The body's current state and the cues performed so far. */
  inspect(): ReturnType<FilmPlayer["inspect"]>;
}
declare global { interface Window { __scfPromo?: PromoRenderApi } }

const readParams = () => {
  const params = new URLSearchParams(location.search);
  const tier = params.get("tier");
  return {
    render: params.get("render") === "1",
    subtitles: params.get("subtitles") !== "0",
    tier: tier !== null && /^[0-4]$/.test(tier) ? Number(tier) : undefined,
  };
};

/**
 * /promo: the SCF Presence film, performed live by the real particle body. Before playback: the black
 * frame and one Play control. During playback: nothing but the film. After: Replay.
 */
export default function PromoExperience() {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const words = useRef<Partial<Record<TitleId | "subtitle" | "blackout", HTMLElement>>>({});
  const [player, setPlayer] = useState<FilmPlayer | null>(null);
  const [render, setRender] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ownFullscreenChange = useRef(false);

  const subscribe = useCallback((listener: () => void) => player?.subscribe(listener) ?? (() => {}), [player]);
  // The player's state and mute flag, re-read whenever it reports a change.
  const [state, muted] = useSyncExternalStore(subscribe, () => player ? `${player.state}|${player.muted}` : "preparing|false", () => "preparing|false")
    .split("|") as [PlayerState, string];

  const register = useCallback((id: TitleId | "subtitle" | "blackout", element: HTMLElement | null) => {
    if (element) words.current[id] = element; else delete words.current[id];
  }, []);

  // One player per mount (and per retry): it owns the particle runtime, the prepared scenes and the sound.
  useEffect(() => {
    const params = readParams();
    const w = words.current;
    if (!canvas.current || !w.question || !w.caption || !w.title || !w.tagline || !w.maker || !w.subtitle || !w.blackout) return;
    const elements: FilmElements = {
      canvas: canvas.current,
      titles: { question: w.question, caption: w.caption, title: w.title, tagline: w.tagline, maker: w.maker },
      subtitle: w.subtitle, blackout: w.blackout,
    };
    const created = new FilmPlayer(elements, {
      mode: params.render ? "render" : "live", subtitles: params.subtitles, tier: params.tier,
      pixelRatio: params.render ? 2 : undefined,
    });
    setRender(params.render);
    setReducedMotion(matchMedia("(prefers-reduced-motion: reduce)").matches);
    setPlayer(created);
    const prepared = created.prepare();
    let disposed = false;
    if (params.render) {
      const ready = prepared.then(() => {
        if (created.state !== "ready" || !created.report) throw new Error(`${created.problem?.code ?? (disposed ? "disposed" : "not-ready")}: ${created.problem?.detail ?? ""}`);
        return created.report;
      });
      ready.catch(() => {}); // a discarded mount's promise is never awaited
      window.__scfPromo = {
        ready,
        renderFrame: (index, present) => created.renderFrame(index, present),
        renderAudio: () => created.renderAudio(),
        moments: () => created.moments(),
        inspect: () => created.inspect(),
      };
    }
    return () => {
      disposed = true;
      created.dispose();
      if (window.__scfPromo?.ready) delete window.__scfPromo;
    };
  }, [attempt]);

  const toggleFullscreen = useCallback(() => {
    ownFullscreenChange.current = true;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.current?.requestFullscreen?.().catch(() => { ownFullscreenChange.current = false; });
  }, []);

  // Keyboard: Space play/pause · Escape pause and reveal controls · F fullscreen · M mute · C subtitles.
  useEffect(() => {
    if (!player || render) return;
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (event.code === "Space") {
        if (target?.tagName === "BUTTON") return;
        event.preventDefault(); player.toggle();
      } else if (event.code === "Escape") player.pause();
      else if (event.code === "KeyF") toggleFullscreen();
      else if (event.code === "KeyM") player.setMuted(!player.muted);
      else if (event.code === "KeyC") player.setSubtitles(!player.subtitles);
    };
    const visibility = () => { if (document.hidden) player.pause(); };
    const fullscreenChange = () => {
      const on = Boolean(document.fullscreenElement);
      setFullscreen(on);
      // Leaving fullscreen with Escape (not our own toggle) is the viewer stepping out: pause.
      if (!on && !ownFullscreenChange.current) player.pause();
      ownFullscreenChange.current = false;
    };
    window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreenChange);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreenChange);
    };
  }, [player, render, toggleFullscreen]);

  // The cursor leaves the film while it plays, and returns on movement.
  useEffect(() => {
    if (render || state !== "playing") return;
    let timer = setTimeout(() => setIdle(true), 1600);
    const move = () => { setIdle(false); clearTimeout(timer); timer = setTimeout(() => setIdle(true), 1600); };
    window.addEventListener("pointermove", move);
    return () => { clearTimeout(timer); window.removeEventListener("pointermove", move); };
  }, [state, render]);
  const cursorHidden = render || (state === "playing" && idle);

  return (
    <div className={styles.stage} ref={stage} data-cursor={cursorHidden ? "hidden" : "visible"}>
      <h1 className="sr-only">SCF Presence — the film</h1>
      <div className={styles.frame}>
        <div className={styles.canvas} ref={canvas} role="img" aria-label="The SCF particle body" />
        <FilmWords register={register} />
        {!render && player && <Controls
          state={state} problem={player.problem} missing={player.report?.missingDialogue ?? []}
          reducedMotion={reducedMotion} muted={muted === "true"} fullscreen={fullscreen}
          onPlay={() => player.play()} onResume={() => player.resume()} onRestart={() => player.play()}
          onRetry={() => setAttempt(n => n + 1)} onFullscreen={toggleFullscreen} onMute={() => player.setMuted(!player.muted)}
        />}
      </div>
    </div>
  );
}

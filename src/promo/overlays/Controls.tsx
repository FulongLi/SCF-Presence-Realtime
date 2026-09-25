"use client";

import type { PromoError } from "../director";
import type { PlayerState } from "../player";
import type { LineId } from "../script";
import styles from "../styles/promo.module.css";

const PROBLEMS: Record<string, string> = {
  "webgpu-unavailable": "This film is rendered live on the SCF particle body, which needs a browser with WebGPU (current Chrome, Edge or Safari).",
  "webgpu-failed": "The graphics device could not be started.",
  "device-lost": "The graphics device was lost.",
  "target-unavailable": "A scene's visual could not be prepared. Check the connection and try again.",
  "wrong-source": "A scene's visual came from the wrong source, so the film will not show it.",
  "visual-failed": "A prepared visual could not be shown.",
  "timeline-invalid": "The film's timeline is inconsistent.",
};

const Play = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor" /></svg>;
const Expand = ({ on }: { on: boolean }) => <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
  {on ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
</svg>;
const Sound = ({ muted }: { muted: boolean }) => <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
  <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
  {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M16 9a4.2 4.2 0 0 1 0 6M18.6 6.5a7.8 7.8 0 0 1 0 11" />}
</svg>;

/**
 * Everything the viewer can press, shown only before the film, while it is paused, and after it has
 * fully finished. During playback this renders nothing.
 */
export function Controls({ state, problem, missing, reducedMotion, muted, fullscreen, onPlay, onResume, onRestart, onRetry, onFullscreen, onMute }: {
  state: PlayerState; problem: PromoError | null; missing: readonly LineId[]; reducedMotion: boolean;
  muted: boolean; fullscreen: boolean;
  onPlay(): void; onResume(): void; onRestart(): void; onRetry(): void; onFullscreen(): void; onMute(): void;
}) {
  if (state === "playing" || state === "rendering") return null;
  const corner = <div className={styles.corner}>
    <button type="button" className={styles.icon} onClick={onMute} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted}><Sound muted={muted} /></button>
    <button type="button" className={styles.icon} onClick={onFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}><Expand on={fullscreen} /></button>
  </div>;
  if (state === "preparing") {
    return <div className={styles.controls}>
      <div className={styles.panel} role="status">
        <p className={styles.brand}>SCF Presence</p>
        <p className={styles.status}>Preparing Presence…</p>
      </div>
    </div>;
  }
  if (state === "failed") {
    const detail = process.env.NODE_ENV === "development" && problem?.detail ? ` (${problem.detail})` : "";
    return <div className={styles.controls}>
      <div className={styles.panel} role="alert">
        <p className={styles.brand}>SCF Presence</p>
        <p className={`${styles.note} ${styles.problem}`}>{(PROBLEMS[problem?.code ?? ""] ?? "The film could not be prepared.") + detail}</p>
        <button type="button" className={styles.text} onClick={onRetry}>Try again</button>
      </div>
    </div>;
  }
  if (state === "paused") {
    return <div className={styles.controls} data-dim="true">
      <div className={styles.panel}>
        <button type="button" className={styles.play} onClick={onResume}><Play />Resume</button>
        <div className={styles.row}>
          <button type="button" className={styles.text} onClick={onRestart}>Restart</button>
        </div>
      </div>
      {corner}
    </div>;
  }
  if (state === "ended") {
    return <div className={styles.controls}>
      <div className={styles.panel}>
        <button type="button" className={styles.text} onClick={onRestart}>Replay</button>
      </div>
    </div>;
  }
  return <div className={styles.controls}>
    <div className={styles.panel}>
      <p className={styles.brand}>SCF Presence</p>
      <button type="button" className={styles.play} onClick={onPlay}><Play />Play film</button>
      {reducedMotion && <p className={styles.note}>Your system asks for reduced motion. This film is made of slow, continuous particle motion; it plays as designed.</p>}
      {missing.length > 0 && <p className={styles.note}>
        Dialogue audio has not been prepared, so the film plays with subtitles only. Run <code>npm run promo:prepare</code>.
      </p>}
    </div>
    {corner}
    <p className={styles.hints}>SPACE PLAY · F FULLSCREEN · M MUTE · C SUBTITLES</p>
  </div>;
}

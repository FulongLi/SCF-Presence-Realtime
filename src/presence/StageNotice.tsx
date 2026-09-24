"use client";

import type { PresenceUi } from "./controller";
import type { Strings } from "./strings";

/**
 * The only words the stage shows: first-run microphone setup and connection problems.
 * Once connected, it renders nothing — the body is the interface.
 */
export function StageNotice({ t, ui, graphicsError, onAllow, onRetry }: {
  t: Strings; ui: PresenceUi; graphicsError: string | null;
  onAllow(): void; onRetry(): void;
}) {
  let content: React.ReactNode = null;
  if (ui.mic === "prompt" || ui.mic === "requesting") {
    content = <div className="notice-card">
      <h2>{t.micTitle}</h2>
      <p>{t.micBody}</p>
      <div className="notice-actions">
        <button className="primary" disabled={ui.mic === "requesting"} onClick={onAllow}>{t.micAllow}</button>
      </div>
    </div>;
  } else if (ui.mic === "denied" || ui.mic === "unavailable") {
    content = <p className="notice-line" role="alert">{ui.mic === "denied" ? t.micDenied : t.micUnavailable}</p>;
  } else if (ui.connection === "error") {
    content = <div className="notice-card" role="alert">
      <p>{t.errors[ui.error ?? ""] ?? t.errors.default}</p>
      <div className="notice-actions"><button className="primary" onClick={onRetry}>{t.retry}</button></div>
    </div>;
  } else if (ui.needsGesture) {
    content = <p className="notice-line">{t.tapToBegin}</p>;
  } else if (ui.connection === "ended") {
    content = <p className="notice-line">{t.ended}</p>;
  } else if (ui.connection === "reconnecting") {
    content = <p className="notice-line" role="status">{t.reconnecting}</p>;
  } else if (ui.connection === "connecting") {
    // Delayed by CSS: a fast connection never shows it.
    content = <p className="notice-line delayed" role="status">{t.connecting}</p>;
  } else if (ui.playback === "blocked") {
    content = <p className="notice-line">{t.tapToHear}</p>;
  }
  const graphics = graphicsError ? <p className="notice-line" role="alert">{t.graphics[graphicsError] ?? t.graphics["webgpu-failed"]}</p> : null;
  if (!content && !graphics) return null;
  return <div className="stage-notice" lang={t.lang}>{content}{graphics}</div>;
}

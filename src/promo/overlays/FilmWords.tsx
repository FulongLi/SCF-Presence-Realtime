"use client";

import { COPY, type TitleId } from "../script";
import styles from "../styles/promo.module.css";

/**
 * The film's words: the four editorial titles, the subtitle line and the final black. They are laid out
 * once and never reflow; the player only writes their opacity each frame.
 */
export function FilmWords({ register }: { register: (id: TitleId | "subtitle" | "blackout", element: HTMLElement | null) => void }) {
  const line = (id: TitleId, className: string, Tag: "p" | "h2" = "p") =>
    <Tag ref={(element: HTMLElement | null) => register(id, element)} className={`${styles.line} ${className}`}>{COPY[id]}</Tag>;
  return (
    <div className={styles.words}>
      {line("question", styles.question)}
      {line("caption", styles.caption)}
      {line("title", styles.title, "h2")}
      {line("tagline", styles.tagline)}
      {line("maker", styles.maker)}
      <p ref={element => register("subtitle", element)} className={`${styles.line} ${styles.subtitle}`} />
      <div ref={element => register("blackout", element)} className={styles.blackout} />
    </div>
  );
}

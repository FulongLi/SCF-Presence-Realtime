import type { ImageIntent } from "../../visual-actions/types";
import { IMAGE_MIME, tokens } from "../net";
import type { ImageCandidate } from "../types";

/**
 * Deterministic candidate ranking. No vision model: relevance from the provider, usable size, an aspect
 * ratio that suits the intent, a raster type we can decode, source reliability, and a penalty for
 * results that are about the thing but not a picture of it (signatures, logos, flags, graves…).
 */
export const PORTRAIT_INTENTS: readonly ImageIntent[] = ["portrait", "celebrity"];
const RELIABILITY: Record<string, number> = { wikipedia: 1, web: 0.9, commons: 0.85, openverse: 0.8 };
const OFF_TOPIC = ["signature", "autograph", "logo", "coat", "arms", "flag", "seal", "grave", "tomb", "plaque",
  "map", "diagram", "chart", "graph", "stamp", "banknote", "coin", "icon", "screenshot", "text", "document"];
export const MIN_SIDE = 160;
export const MIN_RELEVANCE = 0.34;

function aspectScore(aspect: number, intent: ImageIntent) {
  if (PORTRAIT_INTENTS.includes(intent)) return aspect >= 0.6 && aspect <= 1.05 ? 1 : aspect <= 1.6 ? 0.75 : 0.45;
  if (intent === "vehicle" || intent === "product" || intent === "object") {
    return aspect >= 1 && aspect <= 2.1 ? 1 : aspect >= 0.75 ? 0.8 : 0.5;
  }
  return aspect >= 0.6 && aspect <= 2.1 ? 1 : 0.7;
}

/** Score 0..~1 for a candidate, or null when it must not be used at all. */
export function scoreCandidate(candidate: ImageCandidate, query: string, intent: ImageIntent): number | null {
  if (candidate.mime && !(IMAGE_MIME as readonly string[]).includes(candidate.mime)) return null;
  if (candidate.relevance < MIN_RELEVANCE) return null;
  let size = 0.6, shape = 0.7;
  if (candidate.width && candidate.height) {
    const aspect = candidate.width / candidate.height;
    if (Math.min(candidate.width, candidate.height) < MIN_SIDE || aspect > 3.2 || aspect < 0.3) return null;
    size = Math.min(1, Math.min(candidate.width, candidate.height) / 480);
    shape = aspectScore(aspect, intent);
  }
  const asked = new Set(tokens(query));
  const offTopic = tokens(candidate.title).some(word => OFF_TOPIC.includes(word) && !asked.has(word));
  const penalty = offTopic && intent !== "map" ? 0.3 : 0;
  return candidate.relevance * 0.55 + size * 0.15 + shape * 0.15 + (RELIABILITY[candidate.provider] ?? 0.7) * 0.15 - penalty;
}

/** Usable candidates, best first. Ties keep the provider's own order. */
export function rankCandidates(candidates: ImageCandidate[], query: string, intent: ImageIntent): ImageCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreCandidate(candidate, query, intent) }))
    .filter((entry): entry is { candidate: ImageCandidate; index: number; score: number } => entry.score !== null && entry.score > 0.3)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.candidate);
}

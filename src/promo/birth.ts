import type { FormationPlan } from "../particle/formation";
import { seededRandom } from "./random";

/**
 * Scene 1, the birth of presence: how the SCF body assembles itself from nothing (see
 * particle/formation.ts for the path every grain follows).
 *
 * - A handful of grains appear low in the frame and rise slowly; more follow, then many.
 * - Depth varies: distant grains are smaller (perspective) and slower, a few pass close to the camera.
 * - Paths bend continuously toward the body, with one shared swirl, never a vertical rise and a turn.
 * - The outer shell tends to arrive first, so hints of curvature appear before the body is full.
 * - Launches follow their own sparse-to-dense curve (a handful of grains first, then many), and arrivals
 *   follow the authored arrival curve: sparse from ~3.3 s, most of the body by ~6 s, the last by BIRTH_END.
 */
export const BIRTH = {
  seed: 0x5cfb17,
  /** No grain exists before this (the first moment is black and almost silent). */
  firstLaunch: 0.7,
  /** The last grain comes into existence by this time. */
  lastLaunch: 4.7,
  /** Launch curve exponent: share launched by time t grows like ((t − first) / span)^(1 / exponent). */
  launchCurve: 0.5,
  /** Cumulative share of grains arrived by a given time (seconds); piecewise linear. */
  arrivals: [[3.3, 0], [4.0, 0.04], [4.7, 0.17], [5.4, 0.45], [6.1, 0.76], [6.6, 0.88], [7.3, 1]] as const,
  /** Distant grains launch earlier and take longer flights (seconds, across the depth range). */
  depthLead: 0.8,
  /** Shortest flight any grain may be squeezed into. */
  minFlight: 1.6,
  /** How strongly the outer shell is ordered first (0 random, 1 strictly outside-in). */
  shell: 0.55,
  start: {
    /** Grains start under their own side of the body, spread wider than it. */
    spread: 1.45, jitter: 1.05,
    /** Highest start (below the centre of frame) and the depth of the band below it. */
    top: -1.45, band: 2.7,
    /** Depth: correlated with the rest place, plus scatter. */
    depth: 0.6, depthJitter: 1.25, near: 2.2, far: -4.4,
    /** Share of grains that start close to the camera and pass near it. */
    foreground: 0.025,
  },
  rise: [1.3, 2.9] as const,
  swirl: [0.3, 0.8] as const,
};

/** Time by which every grain of a birth plan has arrived. */
export const BIRTH_END = BIRTH.arrivals[BIRTH.arrivals.length - 1][0];

/** Inverse of the cumulative arrival curve: share in [0, 1] → time. */
export function arrivalTime(share: number): number {
  const points = BIRTH.arrivals;
  const s = Math.max(0, Math.min(1, share));
  for (let i = 1; i < points.length; i++) {
    const [t1, c1] = points[i];
    if (s <= c1) {
      const [t0, c0] = points[i - 1];
      return c1 === c0 ? t1 : t0 + (t1 - t0) * (s - c0) / (c1 - c0);
    }
  }
  return points[points.length - 1][0];
}

/**
 * The birth plan for a body whose rest positions are `rest` (capacity × 3). Deterministic for a seed, so
 * every render of the film forms the body identically.
 */
export function createBirthPlan(rest: Float32Array, capacity: number, seed = BIRTH.seed): FormationPlan {
  const random = seededRandom(seed);
  const gauss = () => {
    const u = Math.max(1e-9, random()), v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let radius = 1e-6;
  for (let i = 0; i < capacity; i++) radius = Math.max(radius, Math.hypot(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]));
  // Arrival order: outer shell first (with scatter), so curvature appears before the interior fills.
  const keys = new Float64Array(capacity);
  for (let i = 0; i < capacity; i++) {
    const r = Math.hypot(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]) / radius;
    keys[i] = (1 - r) * BIRTH.shell + random() * (1 - BIRTH.shell);
  }
  const order = Array.from({ length: capacity }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const launch = new Float32Array(capacity * 4), path = new Float32Array(capacity * 4);
  const s = BIRTH.start;
  let end = 0;
  for (let rank = 0; rank < capacity; rank++) {
    const i = order[rank];
    const rx = rest[i * 3], rz = rest[i * 3 + 2];
    const share = (rank + random()) / capacity;
    const arrival = arrivalTime(share);
    const foreground = random() < s.foreground;
    const z = foreground ? s.near + 0.4 + random() * 1.8 : Math.max(s.far, Math.min(s.near, rz * s.depth + gauss() * s.depthJitter));
    // 0 near the camera … 1 far away: distant grains set out earlier, on longer (slower-looking) flights.
    const distance = Math.max(0, Math.min(1, (s.near - z) / (s.near - s.far)));
    const planned = BIRTH.firstLaunch + (BIRTH.lastLaunch - BIRTH.firstLaunch) * Math.pow(share, BIRTH.launchCurve)
      + (random() - 0.5) * 0.3 - (distance - 0.5) * BIRTH.depthLead;
    const at = Math.max(BIRTH.firstLaunch + random() * 0.2, Math.min(planned, arrival - BIRTH.minFlight));
    const flight = arrival - at;
    const x = rx * s.spread + gauss() * s.jitter;
    const y = s.top - Math.pow(random(), 0.7) * s.band;
    launch.set([x, y, z, at], i * 4);
    const rise = BIRTH.rise[0] + random() * (BIRTH.rise[1] - BIRTH.rise[0]);
    const swirl = BIRTH.swirl[0] + random() * (BIRTH.swirl[1] - BIRTH.swirl[0]);
    path.set([flight, swirl, rise, random() * Math.PI * 2], i * 4);
    end = Math.max(end, at + flight);
  }
  return { launch, path, end };
}

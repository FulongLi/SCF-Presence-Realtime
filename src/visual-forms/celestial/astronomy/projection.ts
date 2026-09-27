/**
 * Equatorial coordinates → a flat chart. A gnomonic (tangent-plane) projection around the constellation's
 * own centre, oriented as the sky is seen from the ground: north up, east to the LEFT (right ascension
 * increases to the left). The chart is then centred and scaled into the normalized frame shared by every
 * visual form. No date, time or observer: this is the constellation's shape, not the live sky (a future
 * ephemeris would supply those).
 */
export interface SkyPoint { ra: number; dec: number }
export interface ChartPoint { x: number; y: number }

const RAD = Math.PI / 180;
/** Half-extent of the chart in the normalized frame: the widest side spans ±CHART_EXTENT, leaving a margin. */
export const CHART_EXTENT = 0.86;

/** The direction halfway between the given sky points (the normalized mean of their unit vectors). */
export function skyCentre(points: readonly SkyPoint[]): SkyPoint {
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    x += Math.cos(p.dec * RAD) * Math.cos(p.ra * RAD);
    y += Math.cos(p.dec * RAD) * Math.sin(p.ra * RAD);
    z += Math.sin(p.dec * RAD);
  }
  const length = Math.hypot(x, y, z);
  if (!(length > 1e-9)) throw new Error("sky-centre-undefined");
  return { ra: ((Math.atan2(y, x) / RAD) + 360) % 360, dec: Math.asin(z / length) / RAD };
}

/** Gnomonic projection onto the plane tangent at `centre`, in radians of arc; x grows to the east (left on the chart). */
export function gnomonic(point: SkyPoint, centre: SkyPoint): { xi: number; eta: number } {
  const d = point.dec * RAD, d0 = centre.dec * RAD, da = (point.ra - centre.ra) * RAD;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  if (!(cosc > 0.2)) throw new Error("sky-projection-too-wide");
  return {
    xi: Math.cos(d) * Math.sin(da) / cosc,
    eta: (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc,
  };
}

export interface Chart {
  /** Each input point on the chart, in order: x right (west), y up (north). */
  points: ChartPoint[];
  /** Normalized units per degree of arc near the centre, to size things given in degrees (haze radii). */
  scale: number;
  centre: SkyPoint;
}

/**
 * Projects sky points onto a chart centred in the normalized frame, the longer side spanning ±CHART_EXTENT
 * (aspect preserved). `frame` points take part in the fit; `extra` points are projected with the same
 * transform (e.g. haze centres) without affecting it.
 */
export function chart(frame: readonly SkyPoint[], extra: readonly SkyPoint[] = []): Chart & { extra: ChartPoint[] } {
  if (frame.length < 1) throw new Error("sky-chart-empty");
  const centre = skyCentre(frame);
  const project = (p: SkyPoint) => { const { xi, eta } = gnomonic(p, centre); return { x: -xi, y: eta }; };
  const raw = frame.map(project);
  const xs = raw.map(p => p.x), ys = raw.map(p => p.y);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2, midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  // A single star (or coincident ones) still gets a sensible scale: one degree across the frame.
  const scale = half > 1e-9 ? CHART_EXTENT / half : CHART_EXTENT / RAD;
  const place = (p: { x: number; y: number }) => ({ x: (p.x - midX) * scale, y: (p.y - midY) * scale });
  return { points: raw.map(place), extra: extra.map(p => place(project(p))), scale: scale * RAD, centre };
}

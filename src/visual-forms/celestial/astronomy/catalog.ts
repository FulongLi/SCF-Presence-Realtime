/**
 * Star catalogue vocabulary. Constellations are stored as real equatorial coordinates (J2000 right
 * ascension and declination, as printed in catalogues) plus visual magnitude, never as pictures, so the
 * data can later be replaced by a full catalogue (e.g. Hipparcos/Yale Bright Star) or placed on the live
 * sky by an ephemeris without touching the renderer.
 */
export interface CatalogStar {
  /** Stable key within its constellation, used by the stick-figure lines. */
  id: string;
  /** Proper name or Bayer designation. */
  name: string;
  /** Right ascension, degrees (J2000). */
  ra: number;
  /** Declination, degrees (J2000). */
  dec: number;
  /** Apparent visual magnitude (smaller is brighter). */
  mag: number;
}

/** Diffuse light: a nebula or the glow around a cluster. */
export interface CatalogHaze { ra: number; dec: number; /** Angular radius, degrees. */ radius: number; /** 0..1 */ strength: number }

export interface ConstellationData {
  /** Registry name, e.g. "orion". */
  id: string;
  name: string;
  stars: readonly CatalogStar[];
  /** The stick figure, as pairs of star ids. Empty for a cluster like the Pleiades. */
  lines: readonly (readonly [string, string])[];
  haze?: readonly CatalogHaze[];
}

/** "05 55 10.3" (hours, minutes, seconds of right ascension) → degrees. */
export function ra(value: string): number {
  const [h, m = 0, s = 0] = value.trim().split(/\s+/).map(Number);
  const degrees = (h + m / 60 + s / 3600) * 15;
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60) || !Number.isFinite(degrees)) throw new Error(`catalog-ra-invalid: ${value}`);
  return degrees;
}

/** "-08 12 06" (sign, degrees, arcminutes, arcseconds of declination) → degrees. The sign may be on "-00". */
export function dec(value: string): number {
  const text = value.trim();
  const sign = text.startsWith("-") || text.startsWith("−") ? -1 : 1;
  const [d, m = 0, s = 0] = text.replace(/^[+\-−]/, "").split(/\s+/).map(Number);
  const degrees = sign * (d + m / 60 + s / 3600);
  if (!(d >= 0 && d <= 90 && m >= 0 && m < 60 && s >= 0 && s < 60) || !(Math.abs(degrees) <= 90)) throw new Error(`catalog-dec-invalid: ${value}`);
  return degrees;
}

export const star = (id: string, name: string, rightAscension: string, declination: string, mag: number): CatalogStar =>
  ({ id, name, ra: ra(rightAscension), dec: dec(declination), mag });

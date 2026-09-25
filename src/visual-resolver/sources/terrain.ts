import { fetchImage, fetchJSON, HOSTS, type Fetcher } from "../net";
import { decodeTerrarium, downsampleGrid, heightFieldLimits, rasterizePolygon } from "../transforms/heightfield";
import { ResolveError, type Raster, type TerrainProvider, type TerrainSource } from "../types";

/**
 * Real elevation for any named place, keyless and CORS-enabled:
 *
 *   region name ─► geocoder (OpenStreetMap Nominatim, then Photon) ─► bounding box (+ outline polygon)
 *               ─► AWS Terrain Tiles ("terrarium" PNG, metres in RGB, Web Mercator) ─► elevation grid
 *
 * The outline masks the grid, so "Wales" is Wales rather than its bounding box. Not a GIS engine:
 * one geocoder hit, one tile zoom, at most 16 tiles, a grid of at most 160 cells a side.
 */
export type Box = { west: number; south: number; east: number; north: number };
export interface Place { label: string; box: Box; rings?: [number, number][][]; provider: string }

export const terrainLimits = { maxTiles: 16, maxPixels: 640, maxZoom: 12, minSpan: 0.25, pointSpan: 0.8, maxSpan: 70, tileBytes: 1024 * 1024 };
const TILE_URL = (z: number, x: number, y: number) => `https://${HOSTS.elevation}/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

type NominatimHit = { display_name?: string; name?: string; boundingbox?: string[]; geojson?: { type: string; coordinates: unknown } };
type PhotonFeature = { properties?: { name?: string; country?: string; extent?: number[] }; geometry?: { coordinates?: number[] } };

function polygonRings(geojson: NominatimHit["geojson"]): [number, number][][] | undefined {
  if (!geojson) return undefined;
  const ring = (value: unknown) => Array.isArray(value)
    ? value.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]] as [number, number])
    : [];
  if (geojson.type === "Polygon" && Array.isArray(geojson.coordinates)) return (geojson.coordinates as unknown[]).map(ring).filter(r => r.length > 2);
  if (geojson.type === "MultiPolygon" && Array.isArray(geojson.coordinates)) {
    return (geojson.coordinates as unknown[]).flatMap(polygon => Array.isArray(polygon) ? polygon.map(ring) : []).filter(r => r.length > 2);
  }
  return undefined;
}

/** Expands point-like places, limits continent-sized ones, and keeps latitudes inside Web Mercator. */
export function normalizeBox(box: Box): Box {
  let { west, east } = box;
  if (east < west) east += 360; // crosses the antimeridian
  let south = Math.max(-84, Math.min(84, box.south)), north = Math.max(-84, Math.min(84, box.north));
  const point = east - west < 0.02 && north - south < 0.02;
  const minimum = point ? terrainLimits.pointSpan : terrainLimits.minSpan;
  const grow = (lo: number, hi: number, span: number) => {
    const mid = (lo + hi) / 2, half = Math.min(terrainLimits.maxSpan, Math.max(span, hi - lo)) / 2;
    return [mid - half, mid + half];
  };
  [west, east] = grow(west, east, minimum);
  [south, north] = grow(south, north, minimum);
  return { west, east, south: Math.max(-84, south), north: Math.min(84, north) };
}

export async function geocode(region: string, signal: AbortSignal, request?: Fetcher): Promise<Place> {
  let failure: unknown = null;
  try {
    const url = new URL(`https://${HOSTS.nominatim}/search`);
    url.search = new URLSearchParams({ q: region, format: "jsonv2", limit: "1", polygon_geojson: "1", polygon_threshold: "0.01" }).toString();
    // Nominatim's usage policy asks apps to identify themselves; a browser does so with its origin.
    const { data } = await fetchJSON<NominatimHit[]>(url, { hosts: [HOSTS.nominatim], signal, request, referrer: "strict-origin" });
    const hit = Array.isArray(data) ? data[0] : undefined;
    const b = hit?.boundingbox?.map(Number);
    if (hit && b && b.length === 4 && b.every(Number.isFinite)) {
      return { label: (hit.name || hit.display_name || region).slice(0, 80), box: { south: b[0], north: b[1], west: b[2], east: b[3] }, rings: polygonRings(hit.geojson), provider: "nominatim" };
    }
  } catch (error) { signal.throwIfAborted(); failure = error; }
  try {
    const url = new URL(`https://${HOSTS.photon}/api/`);
    url.search = new URLSearchParams({ q: region, limit: "1" }).toString();
    const { data } = await fetchJSON<{ features?: PhotonFeature[] }>(url, { hosts: [HOSTS.photon], signal, request });
    const feature = data.features?.[0];
    const e = feature?.properties?.extent, c = feature?.geometry?.coordinates;
    if (e?.length === 4 && e.every(Number.isFinite)) {
      return { label: (feature?.properties?.name ?? region).slice(0, 80), box: { west: e[0], north: e[1], east: e[2], south: e[3] }, provider: "photon" };
    }
    if (c?.length === 2 && c.every(Number.isFinite)) {
      return { label: (feature?.properties?.name ?? region).slice(0, 80), box: { west: c[0], east: c[0], south: c[1], north: c[1] }, provider: "photon" };
    }
  } catch (error) { signal.throwIfAborted(); failure = error; }
  throw new ResolveError(failure ? "geocoder-unavailable" : "region-not-found");
}

/** Web Mercator world pixel coordinates at zoom z (256-pixel tiles). */
export const mercatorX = (lon: number, z: number) => (lon + 180) / 360 * 256 * 2 ** z;
export const mercatorY = (lat: number, z: number) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
};

/** The most detailed zoom whose pixel window and tile count stay within bounds. */
export function planTiles(box: Box) {
  for (let z = terrainLimits.maxZoom; z >= 0; z--) {
    const x0 = mercatorX(box.west, z), x1 = mercatorX(box.east, z), y0 = mercatorY(box.north, z), y1 = mercatorY(box.south, z);
    const tiles = (Math.floor((x1 - 1e-9) / 256) - Math.floor(x0 / 256) + 1) * (Math.floor((y1 - 1e-9) / 256) - Math.floor(y0 / 256) + 1);
    if ((x1 - x0 <= terrainLimits.maxPixels && y1 - y0 <= terrainLimits.maxPixels && tiles <= terrainLimits.maxTiles) || z === 0) {
      return { z, x0, x1, y0, y1, tx0: Math.floor(x0 / 256), tx1: Math.floor((x1 - 1e-9) / 256), ty0: Math.floor(y0 / 256), ty1: Math.floor((y1 - 1e-9) / 256) };
    }
  }
  throw new ResolveError("terrain-unavailable");
}

export type TileDecoder = (blob: Blob) => Promise<Raster>;

/**
 * Elevation from AWS Terrain Tiles (Mapzen terrarium encoding; SRTM, GMTED, ETOPO1 and others,
 * roughly 30 m–1 km). Public dataset on the Registry of Open Data on AWS; no key.
 */
export function elevationTilesProvider(decode: TileDecoder, request?: Fetcher, locate = geocode): TerrainProvider {
  return {
    name: "aws-terrain-tiles",
    async resolve(region, _style, signal) {
      const place = await locate(region, signal, request);
      const box = normalizeBox(place.box);
      const plan = planTiles(box);
      const cols = plan.tx1 - plan.tx0 + 1, rows = plan.ty1 - plan.ty0 + 1, n = 2 ** plan.z;
      const mosaicW = cols * 256, mosaicH = rows * 256;
      const mosaic = new Float32Array(mosaicW * mosaicH).fill(NaN);
      const jobs: (() => Promise<void>)[] = [];
      for (let ty = plan.ty0; ty <= plan.ty1; ty++) for (let tx = plan.tx0; tx <= plan.tx1; tx++) {
        if (ty < 0 || ty >= n) continue;
        jobs.push(async () => {
          const { blob } = await fetchImage(TILE_URL(plan.z, ((tx % n) + n) % n, ty), { hosts: [HOSTS.elevation], signal, request, maxBytes: terrainLimits.tileBytes });
          const raster = await decode(blob);
          if (raster.width !== 256 || raster.height !== 256) throw new ResolveError("terrain-tile-invalid");
          const metres = decodeTerrarium(raster);
          const ox = (tx - plan.tx0) * 256, oy = (ty - plan.ty0) * 256;
          for (let y = 0; y < 256; y++) mosaic.set(metres.subarray(y * 256, y * 256 + 256), (oy + y) * mosaicW + ox);
        });
      }
      // Four requests at a time: quick, and polite to the public bucket.
      for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(job => job()));
      signal.throwIfAborted();

      const left = Math.floor(plan.x0 - plan.tx0 * 256), top = Math.floor(plan.y0 - plan.ty0 * 256);
      const width = Math.max(2, Math.min(mosaicW - left, Math.ceil(plan.x1 - plan.x0))), height = Math.max(2, Math.min(mosaicH - top, Math.ceil(plan.y1 - plan.y0)));
      const window = new Float32Array(width * height);
      for (let y = 0; y < height; y++) window.set(mosaic.subarray((top + y) * mosaicW + left, (top + y) * mosaicW + left + width), y * width);
      const grid = downsampleGrid(window, width, height, heightFieldLimits.maxSide);
      let mask: Uint8Array | undefined;
      if (place.rings?.length) {
        const sx = grid.width / (plan.x1 - plan.x0), sy = grid.height / (plan.y1 - plan.y0);
        const project = ([lon, lat]: [number, number]): [number, number] => {
          // Keep polygon longitudes on the same side of the antimeridian as the box.
          const shifted = lon < box.west - 180 ? lon + 360 : lon > box.east + 180 ? lon - 360 : lon;
          return [(mercatorX(shifted, plan.z) - plan.x0) * sx, (mercatorY(lat, plan.z) - plan.y0) * sy];
        };
        mask = rasterizePolygon(place.rings.map(ring => ring.map(project)), grid.width, grid.height);
        let inside = 0;
        for (const cell of mask) inside += cell;
        if (inside < heightFieldLimits.minCells) mask = undefined; // outline too small to use: show the box
      }
      return {
        provider: `aws-terrain-tiles z${plan.z} · ${place.provider}`, kind: "elevation",
        width: grid.width, height: grid.height, values: grid.values, mask,
        aspect: (plan.x1 - plan.x0) / (plan.y1 - plan.y0), label: place.label,
      } satisfies TerrainSource;
    },
  };
}

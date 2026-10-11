import { allocateSourceCap } from './cap.js';
import { CCTV_MAX_SOURCES_CEILING } from './constants.js';

/** Default number of cameras a viewport query returns when it names no limit. */
export const DEFAULT_CCTV_VIEWPORT_LIMIT = 1500;

/**
 * Parse a `bbox=west,south,east,north` query value (WGS84 degrees).
 *
 * West greater than east is a box that crosses the antimeridian, the way
 * Cesium's computeViewRectangle reports one. Anything else malformed is
 * refused rather than guessed at, so a bad query cannot widen into a
 * whole-catalog answer.
 *
 * @param {string|null|undefined} raw - The query value.
 * @returns {?{west:number, south:number, east:number, north:number}}
 */
export function parseCctvBbox(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split(',');
  if (parts.length !== 4) return null;
  const values = parts.map((part) => (part.trim() === '' ? NaN : Number(part)));
  if (!values.every(Number.isFinite)) return null;
  const [west, south, east, north] = values;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  if (south < -90 || north > 90 || south > north) return null;
  return { west, south, east, north };
}

/**
 * Resolve a viewport query's `limit`, bounded to [1, CCTV_MAX_SOURCES_CEILING].
 *
 * @param {string|null|undefined} raw - The query value.
 * @returns {number}
 */
export function resolveViewportLimit(raw) {
  const parsed = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(parsed)) {
    return DEFAULT_CCTV_VIEWPORT_LIMIT;
  }
  return Math.max(1, Math.min(CCTV_MAX_SOURCES_CEILING, Math.floor(parsed)));
}

/** Whether a camera's coordinates fall inside a parsed box. */
export function bboxContains(box, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < box.south || lat > box.north) return false;
  return box.west <= box.east
    ? lon >= box.west && lon <= box.east
    : lon >= box.west || lon <= box.east;
}

/**
 * The cameras inside a box, at most `limit` of them.
 *
 * `sources` is the full loaded set in merge order, each tagged with its
 * `pack`. Cameras are regrouped by pack in that order, each pack keeping its
 * own nearest-to-anchor priority, and the limit is shared round-robin by the
 * same allocator the catalog cap uses, so a wide view thins every region a
 * little instead of filling up with whichever pack merged first.
 *
 * @param {Array<object>} sources - Loaded sources, each with `pack`, `lat`, `lon`.
 * @param {{west:number, south:number, east:number, north:number}} box
 * @param {number} limit
 * @returns {{sources:Array<object>, available:number}}
 */
export function selectSourcesInBbox(sources, box, limit) {
  const byPack = new Map();
  let available = 0;
  for (const source of sources || []) {
    if (!bboxContains(box, Number(source?.lat), Number(source?.lon))) continue;
    available += 1;
    const name = source.pack || '';
    if (!byPack.has(name)) byPack.set(name, { name, sources: [] });
    byPack.get(name).sources.push(source);
  }
  const allocation = allocateSourceCap(Array.from(byPack.values()), limit);
  return { sources: allocation.sources, available };
}

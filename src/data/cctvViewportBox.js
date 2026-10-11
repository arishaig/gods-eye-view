/**
 * Pure box arithmetic and eviction choice for the CCTV viewport tier. Boxes
 * are {west, south, east, north} in degrees; west > east means the box
 * crosses the antimeridian, the way Cesium's computeViewRectangle reports it.
 */

const wrapLon = (lon) => {
  let value = ((((lon + 180) % 360) + 360) % 360) - 180;
  // Keep +180 as +180 rather than folding it to −180 so an exact edge stays put.
  if (value === -180 && lon > 0) value = 180;
  return value;
};

/** Longitude span of a box in degrees, 0–360. */
export function boxLonSpan(box) {
  return box.east >= box.west ? box.east - box.west : box.east + 360 - box.west;
}

/** Latitude span of a box in degrees. */
export function boxLatSpan(box) {
  return box.north - box.south;
}

/** Whether a point lies inside a box. */
export function boxContainsPoint(box, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < box.south || lat > box.north) return false;
  return box.west <= box.east
    ? lon >= box.west && lon <= box.east
    : lon >= box.west || lon <= box.east;
}

/**
 * The box grown by `fraction` of its own span on every side, clamped to the
 * poles; a box that would wrap the whole globe in longitude becomes −180..180.
 */
export function padBox(box, fraction) {
  const lonPad = boxLonSpan(box) * fraction;
  const latPad = boxLatSpan(box) * fraction;
  const south = Math.max(-90, box.south - latPad);
  const north = Math.min(90, box.north + latPad);
  if (boxLonSpan(box) + 2 * lonPad >= 360) {
    return { west: -180, south, east: 180, north };
  }
  return {
    west: wrapLon(box.west - lonPad),
    south,
    east: wrapLon(box.east + lonPad),
    north,
  };
}

/** Whether `inner` lies entirely inside `outer` (antimeridian-aware). */
export function boxInside(inner, outer) {
  if (!inner || !outer) return false;
  if (inner.south < outer.south || inner.north > outer.north) return false;
  const outerWest = outer.west;
  const outerEast = outer.east >= outer.west ? outer.east : outer.east + 360;
  const innerSpan = boxLonSpan(inner);
  for (const shift of [-360, 0, 360]) {
    const west = inner.west + shift;
    if (west >= outerWest && west + innerSpan <= outerEast) return true;
  }
  return false;
}

/** The centre point of a box. */
export function boxCenter(box) {
  return {
    lat: (box.south + box.north) / 2,
    lon: wrapLon(box.west + boxLonSpan(box) / 2),
  };
}

/**
 * Which viewport-tier records to evict so at most `max` remain: never one in
 * view, never a protected id (the active, calibrating or hovered camera), and
 * farthest from the view centre first. Startup-catalog records are never
 * candidates. May return fewer than the excess when the rest are protected.
 *
 * @param {Array<{tier?:string, camera:{id:string, lat:number, lon:number}}>} records
 * @param {Object} options
 * @param {{west:number, south:number, east:number, north:number}} options.box - Current view.
 * @param {number} options.max - Viewport-tier records to keep.
 * @param {Set<string>} [options.protectedIds]
 * @param {(a:{lat:number,lon:number}, b:{lat:number,lon:number}) => number} options.distance
 * @returns {Array<object>} Records to remove.
 */
export function pickViewportEvictions(
  records,
  { box, max, protectedIds = new Set(), distance },
) {
  const viewport = records.filter((record) => record?.tier === 'viewport');
  const excess = viewport.length - Math.max(0, max);
  if (excess <= 0) return [];
  const center = boxCenter(box);
  return viewport
    .filter(
      (record) =>
        !protectedIds.has(record.camera.id) &&
        !boxContainsPoint(box, record.camera.lat, record.camera.lon),
    )
    .map((record) => ({ record, km: distance(center, record.camera) }))
    .sort((a, b) => b.km - a.km)
    .slice(0, excess)
    .map((entry) => entry.record);
}

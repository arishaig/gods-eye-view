/**
 * Browser keys supplied at page load by `/gev-runtime-config.js`
 * (server/standalone/runtime-config.js), falling back to the value compiled
 * in at build time. A missing script, or a blank field, keeps the build-time
 * value.
 *
 * @param {'googleApiKey'|'cesiumToken'|'mapillaryToken'} field
 * @param {string|undefined} buildValue
 * @returns {string|undefined}
 */
export function runtimeKey(field, buildValue) {
  const value = globalThis.__GEV_RUNTIME_CONFIG__?.[field];
  return typeof value === 'string' && value.trim() ? value : buildValue;
}

/** Startup view when GEV_HOME_VIEW is unset or unusable: Austin, TX. */
export const DEFAULT_HOME_VIEW = Object.freeze({
  lat: 30.2672,
  lon: -97.7431,
  height: 600,
  label: 'Austin, TX',
});

/**
 * The startup view from GEV_HOME_VIEW (`lat,lon[,height_m]`), else
 * DEFAULT_HOME_VIEW. A malformed or out-of-range value falls back rather
 * than flying somewhere nonsensical.
 *
 * @param {unknown} [value]
 * @returns {{lat: number, lon: number, height: number, label: string|null}}
 */
export function runtimeHomeView(
  value = globalThis.__GEV_RUNTIME_CONFIG__?.homeView,
) {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_HOME_VIEW;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === ''))
    return DEFAULT_HOME_VIEW;
  const [lat, lon, height = DEFAULT_HOME_VIEW.height] = parts.map(Number);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(height) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    height <= 0 ||
    height > 20_000_000
  )
    return DEFAULT_HOME_VIEW;
  // No label: the coordinates are deployment configuration, kept off-screen.
  return Object.freeze({ lat, lon, height, label: null });
}

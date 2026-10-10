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

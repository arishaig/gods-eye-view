/**
 * `/gev-runtime-config.js`: the browser-side keys, read from the server's
 * environment when the page loads instead of compiled into the bundle.
 *
 * `vite build` inlines GOOGLE_MAPS_API_KEY, CESIUM_ION_TOKEN and
 * MAPILLARY_CLIENT_TOKEN (build/vite.js `define`), so one build carries one
 * set of keys. Serving them here lets a keyless build — a container image, for
 * example — take its keys from the environment it runs in. Build-time values
 * still work: the browser prefers this script's values and falls back to them
 * (src/runtimeConfig.js).
 *
 * Only keys that are public by design reach this script: the Google Maps
 * browser key (restrict it by HTTP referrer), the Cesium ion `assets:read`
 * token and the Mapillary client token. Server-side secrets never do.
 *
 * It also carries GEV_HOME_VIEW, the startup view (`lat,lon[,height_m]`) used
 * when the URL holds no shared view. It is not a key, but it is browser-side
 * configuration that differs per deployment, so it travels the same way.
 */

/** Environment names the browser may see, by runtime-config field. */
export const RUNTIME_CONFIG_KEYS = Object.freeze({
  googleApiKey: 'GOOGLE_MAPS_API_KEY',
  cesiumToken: 'CESIUM_ION_TOKEN',
  mapillaryToken: 'MAPILLARY_CLIENT_TOKEN',
  homeView: 'GEV_HOME_VIEW',
});

export const RUNTIME_CONFIG_PATH = '/gev-runtime-config.js';

/**
 * The script body for `env`. Blank values are left out, so the browser falls
 * back to the build-time value for them.
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
export function runtimeConfigScript(env = process.env) {
  const config = {};
  for (const [field, name] of Object.entries(RUNTIME_CONFIG_KEYS)) {
    const value = String(env[name] ?? '').trim();
    if (value) config[field] = value;
  }
  // JSON.stringify output is a valid JavaScript expression; escaping `<`
  // keeps the body inert even if it is ever inlined into HTML.
  const literal = JSON.stringify(config).replaceAll('<', '\\u003c');
  return `window.__GEV_RUNTIME_CONFIG__ = Object.freeze(${literal});\n`;
}

/** Vite plugin serving the runtime config on the dev and preview servers. */
export function runtimeConfigPlugin() {
  const install = (server) => {
    server.middlewares.use(RUNTIME_CONFIG_PATH, (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : runtimeConfigScript());
    });
  };
  return {
    name: 'gev-runtime-config',
    configureServer: install,
    configurePreviewServer: install,
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clientAddress,
  isTrustedProxy,
  parseTrustedProxies,
  requestView,
} from '../server/providers/common/trusted-proxy.js';
import { admitSameSiteRequest } from './localRequestGate.mjs';
import {
  RUNTIME_CONFIG_KEYS,
  runtimeConfigScript,
} from '../server/standalone/runtime-config.js';
import {
  DEFAULT_HOME_VIEW,
  runtimeHomeView,
  runtimeKey,
} from './runtimeConfig.js';

const proxies = parseTrustedProxies('10.244.0.0/16, 192.168.1.5');

function req({ peer, headers = {}, encrypted = false }) {
  return { socket: { remoteAddress: peer, encrypted }, headers };
}

test('an unset or blank GEV_TRUSTED_PROXIES trusts nothing', () => {
  assert.equal(parseTrustedProxies(undefined), null);
  assert.equal(parseTrustedProxies(' , '), null);
  assert.equal(isTrustedProxy('127.0.0.1', null), false);
});

test('CIDR ranges and single addresses match, IPv4-mapped peers included', () => {
  assert.equal(isTrustedProxy('10.244.3.7', proxies), true);
  assert.equal(isTrustedProxy('::ffff:10.244.3.7', proxies), true);
  assert.equal(isTrustedProxy('192.168.1.5', proxies), true);
  assert.equal(isTrustedProxy('192.168.1.6', proxies), false);
  assert.equal(isTrustedProxy('not-an-ip', proxies), false);
});

test('malformed entries are skipped, never widening trust', () => {
  const skipped = [];
  const list = parseTrustedProxies(
    '10.0.0.0/33, 10.0.0.1/8/1, example.com, 10.0.0.0/x, *, 172.16.0.1',
    { onInvalid: (entry) => skipped.push(entry) },
  );
  assert.deepEqual(skipped, [
    '10.0.0.0/33',
    '10.0.0.1/8/1',
    'example.com',
    '10.0.0.0/x',
    '*',
  ]);
  assert.equal(isTrustedProxy('172.16.0.1', list), true);
  assert.equal(isTrustedProxy('10.0.0.1', list), false);
});

test('an untrusted peer keeps the socket view and its forwarding headers are ignored', () => {
  const view = requestView(
    req({
      peer: '203.0.113.9',
      headers: {
        host: 'globe.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example',
      },
    }),
    proxies,
  );
  assert.deepEqual(view, {
    trusted: false,
    protocol: 'http:',
    hostHeader: 'globe.example',
  });
});

test('a trusted proxy supplies the client-facing protocol and host', () => {
  const view = requestView(
    req({
      peer: '10.244.0.12',
      headers: {
        host: 'globe.example',
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'Globe.Example',
      },
    }),
    proxies,
  );
  assert.deepEqual(view, {
    trusted: true,
    protocol: 'https:',
    hostHeader: 'globe.example',
  });
});

test('a trusted proxy with an unusable X-Forwarded-Proto keeps the socket protocol', () => {
  const view = requestView(
    req({
      peer: '10.244.0.12',
      headers: { host: 'globe.example', 'x-forwarded-proto': 'gopher' },
    }),
    proxies,
  );
  assert.equal(view.protocol, 'http:');
  assert.equal(view.hostHeader, 'globe.example');
});

test('the rate-limit key ignores X-Forwarded-For from an untrusted peer', () => {
  const r = req({
    peer: '203.0.113.9',
    headers: { 'x-forwarded-for': '198.51.100.1' },
  });
  assert.equal(clientAddress(r, proxies), '203.0.113.9');
  assert.equal(clientAddress(r, null), '203.0.113.9');
});

test('the rate-limit key is the rightmost hop a trusted proxy did not write', () => {
  // The client prepended a fake hop; the proxy appended the real address.
  const r = req({
    peer: '10.244.0.12',
    headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.7, 10.244.1.1' },
  });
  assert.equal(clientAddress(r, proxies), '198.51.100.7');
});

test('a trusted proxy with no usable X-Forwarded-For keys on the proxy itself', () => {
  assert.equal(clientAddress(req({ peer: '10.244.0.12' }), proxies), '10.244.0.12');
  assert.equal(
    clientAddress(
      req({ peer: '10.244.0.12', headers: { 'x-forwarded-for': 'garbage' } }),
      proxies,
    ),
    '10.244.0.12',
  );
});

const proxiedSameOrigin = {
  hostHeader: 'globe.example',
  protocol: 'https:',
  origin: 'https://globe.example',
  secFetchSite: 'same-origin',
  proxyHeaders: { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' },
};

test('the gate still refuses proxied requests by default', () => {
  const r = admitSameSiteRequest(proxiedSameOrigin);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('the gate admits a same-origin request through a trusted proxy', () => {
  assert.equal(
    admitSameSiteRequest({ ...proxiedSameOrigin, trustedProxy: true }).ok,
    true,
  );
});

test('a trusted proxy does not relax the cross-site and Origin rules', () => {
  for (const change of [
    { origin: 'https://evil.example' },
    { origin: 'http://globe.example' },
    { origin: 'null' },
    { secFetchSite: 'cross-site', origin: undefined },
  ]) {
    const r = admitSameSiteRequest({
      ...proxiedSameOrigin,
      ...change,
      trustedProxy: true,
    });
    assert.equal(r.ok, false, JSON.stringify(change));
  }
});

test('only the literal true opts the gate into proxy trust', () => {
  assert.equal(
    admitSameSiteRequest({ ...proxiedSameOrigin, trustedProxy: 'true' }).ok,
    false,
  );
});

test('the runtime config script carries only the public browser keys', () => {
  const script = runtimeConfigScript({
    GOOGLE_MAPS_API_KEY: 'g-key',
    CESIUM_ION_TOKEN: ' ',
    MAPILLARY_CLIENT_TOKEN: 'MLY|x</script>',
    OPENAI_API_KEY: 'sk-secret',
    GOOGLE_MAPS_SERVER_API_KEY: 'server-secret',
    GEV_HOME_VIEW: '1.5,2.5,300',
  });
  assert.doesNotMatch(script, /sk-secret|server-secret|<\/script>/);
  const sandbox = {};
  new Function('window', script)(sandbox);
  assert.deepEqual({ ...sandbox.__GEV_RUNTIME_CONFIG__ }, {
    googleApiKey: 'g-key',
    mapillaryToken: 'MLY|x</script>',
    homeView: '1.5,2.5,300',
  });
  assert.deepEqual(Object.values(RUNTIME_CONFIG_KEYS).sort(), [
    'CESIUM_ION_TOKEN',
    'GEV_HOME_VIEW',
    'GOOGLE_MAPS_API_KEY',
    'MAPILLARY_CLIENT_TOKEN',
  ]);
});

test('runtime keys win over build-time keys, and blanks fall back', () => {
  const previous = globalThis.__GEV_RUNTIME_CONFIG__;
  try {
    delete globalThis.__GEV_RUNTIME_CONFIG__;
    assert.equal(runtimeKey('cesiumToken', 'built'), 'built');
    globalThis.__GEV_RUNTIME_CONFIG__ = { cesiumToken: 'runtime', googleApiKey: ' ' };
    assert.equal(runtimeKey('cesiumToken', 'built'), 'runtime');
    assert.equal(runtimeKey('googleApiKey', 'built'), 'built');
    assert.equal(runtimeKey('mapillaryToken', undefined), undefined);
  } finally {
    if (previous === undefined) delete globalThis.__GEV_RUNTIME_CONFIG__;
    else globalThis.__GEV_RUNTIME_CONFIG__ = previous;
  }
});

test('GEV_HOME_VIEW sets the startup view; unusable values keep Austin', () => {
  assert.equal(runtimeHomeView(undefined), DEFAULT_HOME_VIEW);
  assert.equal(runtimeHomeView(' '), DEFAULT_HOME_VIEW);
  assert.deepEqual(
    { ...runtimeHomeView(' 10.25, -20.5 ') },
    { lat: 10.25, lon: -20.5, height: DEFAULT_HOME_VIEW.height, label: null },
  );
  assert.deepEqual(
    { ...runtimeHomeView('10,20,5000') },
    { lat: 10, lon: 20, height: 5000, label: null },
  );
  for (const bad of [
    '10',
    '10,',
    '91,0',
    '0,181',
    '0,0,0',
    '0,0,-5',
    'a,b',
    '1,2,3,4',
    '0,0,99999999',
  ])
    assert.equal(runtimeHomeView(bad), DEFAULT_HOME_VIEW, bad);
});

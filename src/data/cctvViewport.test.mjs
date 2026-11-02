// Viewport camera queries: the global list stays capped by CCTV_MAX_SOURCES,
// while GET /api/cctv/sources?bbox=… answers from every loaded camera, and
// every loaded camera — not only the capped list — resolves on /frame.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  DEFAULT_CCTV_VIEWPORT_LIMIT,
  bboxContains,
  parseCctvBbox,
  resolveViewportLimit,
  selectSourcesInBbox,
} from '../../server/providers/cctv/bbox.js';
import { CCTV_MAX_SOURCES_CEILING } from '../../server/providers/cctv/constants.js';

test('bbox parsing accepts west,south,east,north and refuses anything else', () => {
  assert.deepEqual(parseCctvBbox('-122.5,47.4,-122.2,47.8'), {
    west: -122.5,
    south: 47.4,
    east: -122.2,
    north: 47.8,
  });
  // Crossing the antimeridian: west > east is a real box, not an error.
  assert.deepEqual(parseCctvBbox('170,-20,-170,-10'), {
    west: 170,
    south: -20,
    east: -170,
    north: -10,
  });
  for (const bad of [
    '',
    null,
    undefined,
    '1,2,3',
    '1,2,3,4,5',
    'a,b,c,d',
    '1,,3,4',
    '-181,0,10,10',
    '0,0,181,10',
    '0,-91,10,10',
    '0,0,10,91',
    // South above north is never a box.
    '0,20,10,10',
    'Infinity,0,10,10',
  ]) {
    assert.equal(parseCctvBbox(bad), null, String(bad));
  }
});

test('the viewport limit defaults, floors and clamps to the ceiling', () => {
  assert.equal(resolveViewportLimit(null), DEFAULT_CCTV_VIEWPORT_LIMIT);
  assert.equal(resolveViewportLimit(''), DEFAULT_CCTV_VIEWPORT_LIMIT);
  assert.equal(resolveViewportLimit('nope'), DEFAULT_CCTV_VIEWPORT_LIMIT);
  assert.equal(resolveViewportLimit('12.9'), 12);
  assert.equal(resolveViewportLimit('0'), 1);
  assert.equal(resolveViewportLimit('-5'), 1);
  assert.equal(resolveViewportLimit('999999'), CCTV_MAX_SOURCES_CEILING);
});

test('containment handles ordinary and antimeridian-crossing boxes', () => {
  const seattle = parseCctvBbox('-122.5,47.4,-122.2,47.8');
  assert.equal(bboxContains(seattle, 47.6, -122.33), true);
  assert.equal(bboxContains(seattle, 47.6, -122.6), false);
  assert.equal(bboxContains(seattle, 48, -122.33), false);
  assert.equal(bboxContains(seattle, NaN, -122.33), false);

  const pacific = parseCctvBbox('170,-20,-170,-10');
  assert.equal(bboxContains(pacific, -15, 175), true);
  assert.equal(bboxContains(pacific, -15, -175), true);
  assert.equal(bboxContains(pacific, -15, 0), false);
});

test('a box shares its limit round-robin across packs, each in its own order', () => {
  const camera = (pack, i, lat = 10, lon = 10) => ({
    id: `${pack}-${i}`,
    pack,
    lat,
    lon,
  });
  const sources = [
    ...Array.from({ length: 10 }, (_, i) => camera('a', i)),
    ...Array.from({ length: 10 }, (_, i) => camera('b', i)),
    // Outside the box: never counted, never served.
    camera('c', 0, -40, -40),
  ];
  const box = parseCctvBbox('0,0,20,20');
  const { sources: picked, available } = selectSourcesInBbox(sources, box, 4);
  assert.equal(available, 20);
  assert.deepEqual(
    picked.map((s) => s.id),
    ['a-0', 'b-0', 'a-1', 'b-1'],
  );
  // Under the limit everything in the box comes back.
  assert.equal(selectSourcesInBbox(sources, box, 100).sources.length, 20);
});

// ---------------------------------------------------------------------------
// The mounted route.
// ---------------------------------------------------------------------------

/** Twenty cameras on a line running north from 47.50°N, all one env pack. */
const CAMERAS = Array.from({ length: 20 }, (_, i) => ({
  id: `vp-${i}`,
  name: `Viewport fixture ${i}`,
  lat: 47.5 + i * 0.01,
  lon: -122.3,
  feedType: 'image',
  url: `https://upstream.invalid/vp-${i}.jpg`,
}));

function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

/** Mount the real provider over CAMERAS with the global list capped at 8. */
function mount(t) {
  const saved = {};
  const env = {
    CCTV_SOURCES_JSON: JSON.stringify(CAMERAS),
    CCTV_SOURCES_FILE: 'absent-source-file.json',
    CCTV_FORCE_AUSTIN: '0',
    CCTV_MAX_SOURCES: '8',
    GOOGLE_MAPS_API_KEY: '',
    GOOGLE_SERVER_API_KEY: '',
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  t.mock.method(console, 'warn', () => {});

  let handler = null;
  cctvProxy().configureServer({
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  const call = async (path) => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers: {}, method: 'GET', on() {} }, res);
    await done;
    return res;
  };
  return { call, requests };
}

test('the global list stays capped and advertises viewport queries', async (t) => {
  const { call } = mount(t);
  const res = await call('/sources');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.sources.length, 8, 'CCTV_MAX_SOURCES still bounds it');
  assert.deepEqual(body.viewport, { bbox: true, loaded: 20 });
  // Upstream URLs never reach the client.
  assert.equal(
    body.sources.some((s) => 'url' in s),
    false,
  );
});

test('a viewport query answers from every loaded camera, past the global cap', async (t) => {
  const { call } = mount(t);
  const global = JSON.parse((await call('/sources')).body);
  const globalIds = new Set(global.sources.map((s) => s.id));

  // The north end of the line: cameras 15–19.
  const res = await call('/sources?bbox=-122.4,47.645,-122.2,47.7');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.sources.map((s) => s.id).sort(), [
    'vp-15',
    'vp-16',
    'vp-17',
    'vp-18',
    'vp-19',
  ]);
  assert.deepEqual(body.scope.bbox, {
    west: -122.4,
    south: 47.645,
    east: -122.2,
    north: 47.7,
  });
  assert.equal(body.scope.available, 5);
  assert.equal(body.scope.served, 5);
  assert.ok(
    body.sources.some((s) => !globalIds.has(s.id)),
    'the box reaches cameras the capped global list left out',
  );
  assert.equal(
    body.sources.some((s) => 'url' in s),
    false,
  );

  const limited = JSON.parse(
    (await call('/sources?bbox=-122.4,47.4,-122.2,47.8&limit=3')).body,
  );
  assert.equal(limited.sources.length, 3);
  assert.equal(limited.scope.available, 20);
});

test('a malformed bbox is a 400, never a whole-catalog answer', async (t) => {
  const { call } = mount(t);
  for (const bad of ['', 'nope', '0,20,10,10', '-200,0,0,10']) {
    const res = await call(`/sources?bbox=${encodeURIComponent(bad)}`);
    assert.equal(res.statusCode, 400, bad);
    assert.equal(JSON.parse(res.body).sources, undefined);
  }
});

test('a camera only a viewport query returned still resolves on /frame', async (t) => {
  const { call, requests } = mount(t);
  const global = JSON.parse((await call('/sources')).body);
  const outside = CAMERAS.find(
    (camera) => !global.sources.some((s) => s.id === camera.id),
  );
  assert.ok(outside, 'the fixture must leave a camera out of the global list');

  const res = await call(`/frame/${encodeURIComponent(outside.id)}`);
  assert.equal(res.statusCode, 200);
  assert.ok(
    requests.includes(outside.url),
    'the frame comes from the registered upstream, not a fallback',
  );
});

test('an id outside the loaded set is still never proxied', async (t) => {
  const { call, requests } = mount(t);
  await call('/sources');
  await call('/frame/not-a-camera');
  assert.equal(
    requests.some((url) => url.startsWith('https://upstream.invalid/')),
    false,
  );
});

test('an id lookup answers from every loaded camera and is empty for unknown ids', async (t) => {
  const { call } = mount(t);
  const global = JSON.parse((await call('/sources')).body);
  const outside = CAMERAS.find(
    (camera) => !global.sources.some((s) => s.id === camera.id),
  );
  const found = JSON.parse(
    (await call(`/sources?id=${encodeURIComponent(outside.id)}`)).body,
  );
  assert.deepEqual(
    found.sources.map((s) => s.id),
    [outside.id],
  );
  assert.equal('url' in found.sources[0], false);
  const missing = JSON.parse((await call('/sources?id=not-a-camera')).body);
  assert.deepEqual(missing.sources, []);
});

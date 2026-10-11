import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadSeattleSourcesFromOpenData,
  normalizeSeattleImageUrl,
  seattleCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_SEATTLE_CCTV_URL,
  SEATTLE_IMAGE_ORIGIN,
  SEATTLE_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import { CAMERA_CODE_MAX_CHARS } from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { directionToHeading } from './directionText.js';

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/** One City of Seattle layer feature, shaped like the live GeoJSON query. */
const feature = (overrides = {}, geometry) => ({
  type: 'Feature',
  id: 387342,
  geometry:
    geometry === undefined
      ? { type: 'Point', coordinates: [-122.297414682629, 47.5992328395492] }
      : geometry,
  properties: {
    UNITID: 'CMR-0270',
    OWNERSHIP: 'SDOT',
    LOCATION: 'MLK Jr Way S & S Jackson St',
    URL: 'http://www.seattle.gov/trafficcams/images/MLK_S_Jackson_NS.jpg',
    SERVSTAT: 'ACTV',
    ...overrides,
  },
});

const collection = (features, extra = {}) => ({
  type: 'FeatureCollection',
  features,
  ...extra,
});

test('a Seattle feature maps to a source on the pinned HTTPS frame path', () => {
  const source = seattleCameraToSource(feature());
  assert.equal(source.id, 'sdot-cmr-0270');
  assert.equal(source.name, 'MLK Jr Way S & S Jackson St');
  assert.equal(source.city, 'Seattle');
  assert.equal(source.cityId, 'seattle');
  assert.equal(source.provider, 'Seattle Department of Transportation');
  assert.equal(source.lat, 47.5992328395492);
  assert.equal(source.lon, -122.297414682629);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'seattle-open-data');
  assert.equal(
    source.license,
    'City of Seattle, Seattle Department of Transportation',
  );
  // The layer publishes http://; the registered URL is the upgraded one.
  assert.equal(
    source.url,
    'https://www.seattle.gov/trafficcams/images/MLK_S_Jackson_NS.jpg',
  );
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(SEATTLE_IMAGE_ORIGIN));
});

test('no heading is derived from the filename axis or corner token', () => {
  // "_NS"/"_EW" name the street axis a camera covers and "_NWC" the corner it
  // is mounted on. Parsed as compass text they become confident bearings that
  // are wrong for half or more of the cameras, so nobody may wire them up.
  assert.equal(directionToHeading('NW', true), 315);

  const base = seattleCameraToSource(feature());
  for (const file of [
    'MLK_S_Jackson_NS.jpg',
    'MLK_S_Jackson_EW.jpg',
    'MLK_S_Jackson_NWC.jpg',
    'MLK_S_Jackson_SEC.jpg',
  ]) {
    const source = seattleCameraToSource(
      feature({
        URL: `https://www.seattle.gov/trafficcams/images/${file}`,
      }),
    );
    assert.equal(source.headingConfidence, 'low');
    assert.ok(Number.isFinite(source.headingDeg));
    // Same id, same fallback heading, whatever the filename says.
    assert.equal(source.headingDeg, base.headingDeg);
  }
});

test('out-of-service, WSDOT-owned, off-city and unusable rows are dropped', () => {
  // The query filters these server-side; the mapper re-checks so a URL
  // override or a layer schema change cannot register them.
  assert.equal(seattleCameraToSource(feature({ SERVSTAT: null })), null);
  assert.equal(seattleCameraToSource(feature({ SERVSTAT: 'INACT' })), null);
  assert.equal(
    seattleCameraToSource(
      feature({
        OWNERSHIP: 'WSDOT',
        URL: 'https://www.seattle.gov/trafficcams/images/SR99_Raye.jpg',
      }),
    ),
    null,
  );
  // Tacoma: plausible lat/lon, but not a Seattle city camera.
  assert.equal(
    seattleCameraToSource(
      feature({}, { type: 'Point', coordinates: [-122.4443, 47.2529] }),
    ),
    null,
  );
  // Null island, missing and short geometry.
  assert.equal(
    seattleCameraToSource(feature({}, { type: 'Point', coordinates: [0, 0] })),
    null,
  );
  assert.equal(seattleCameraToSource(feature({}, null)), null);
  assert.equal(
    seattleCameraToSource(feature({}, { coordinates: [-122.3] })),
    null,
  );
  // No usable id.
  assert.equal(seattleCameraToSource(feature({ UNITID: '' })), null);
  assert.equal(seattleCameraToSource(feature({ UNITID: '../x' })), null);
  assert.equal(seattleCameraToSource(null), null);
});

test('a catalog edit cannot steer the frame proxy off the City path', () => {
  for (const url of [
    'https://evil.example/trafficcams/images/x.jpg',
    'https://www.seattle.gov.evil.test/trafficcams/images/x.jpg',
    'https://www.seattle.gov/other/x.jpg',
    'file:///etc/passwd',
    // A real malformed row from the live layer: the field holds a label and a
    // tab before the URL, so it does not parse as one.
    'URL\thttps://www.seattle.gov/trafficcams/images/6_N_Denny_NWC.jpg',
    '',
    null,
  ]) {
    assert.equal(seattleCameraToSource(feature({ URL: url })), null, url);
  }
});

test('frame URLs upgrade to HTTPS', () => {
  assert.equal(
    normalizeSeattleImageUrl(
      'http://www.seattle.gov/trafficcams/images/23_S_Dearborn_NS.jpg',
    ),
    'https://www.seattle.gov/trafficcams/images/23_S_Dearborn_NS.jpg',
  );
  assert.equal(
    normalizeSeattleImageUrl(
      'https://www.seattle.gov/trafficcams/images/23_S_Dearborn_NS.jpg',
    ),
    'https://www.seattle.gov/trafficcams/images/23_S_Dearborn_NS.jpg',
  );
  assert.equal(normalizeSeattleImageUrl('not a url'), null);
});

test('a nameless row still gets a label, and the code is the intersection', () => {
  assert.equal(
    seattleCameraToSource(feature({ LOCATION: '  ' })).name,
    'Seattle Camera CMR-0270',
  );
  assert.equal(
    seattleCameraToSource(feature()).code,
    'MLK JR WAY S & S JACKSON ST',
  );
  const long = seattleCameraToSource(
    feature({
      LOCATION: 'Martin Luther King Jr Way S & S Jackson St / Rainier Ave S',
    }),
  );
  assert.equal(long.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
});

test('the loader reads the keyless catalog, dedupes and orders by downtown', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push([String(url), init.redirect]);
    return Response.json(
      collection([
        // Lake City: far from downtown.
        feature(
          {
            UNITID: 'CMR-0400',
            LOCATION: 'Lake City Way NE & NE 125th St',
            URL: 'https://www.seattle.gov/trafficcams/images/LCW_125_NS.jpg',
          },
          { type: 'Point', coordinates: [-122.2953, 47.7195] },
        ),
        feature(),
        // Same unit twice: one camera, not two.
        feature({ LOCATION: 'MLK Jr Way S & S Jackson St (duplicate)' }),
        feature({ UNITID: 'CMR-0999', URL: 'https://evil.example/x.jpg' }),
      ]),
    );
  });
  const saved = process.env.CCTV_SEATTLE_URL;
  delete process.env.CCTV_SEATTLE_URL;
  try {
    const cameras = await loadSeattleSourcesFromOpenData();
    assert.deepEqual(requested, [[DEFAULT_SEATTLE_CCTV_URL, 'manual']]);
    assert.deepEqual(
      cameras.map((camera) => camera.id),
      ['sdot-cmr-0270', 'sdot-cmr-0400'],
    );
    assert.equal(cameras[0].name, 'MLK Jr Way S & S Jackson St');
  } finally {
    if (saved !== undefined) process.env.CCTV_SEATTLE_URL = saved;
  }
});

test('the default query asks for SDOT-owned, in-service cameras in WGS84', () => {
  const url = new URL(DEFAULT_SEATTLE_CCTV_URL);
  assert.equal(url.hostname, 'services.arcgis.com');
  assert.equal(
    url.searchParams.get('where'),
    "OWNERSHIP='SDOT' AND SERVSTAT='ACTV'",
  );
  assert.equal(url.searchParams.get('outSR'), '4326');
  assert.equal(url.searchParams.get('f'), 'geojson');
});

test('a truncated layer response is reported, not silently accepted', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      collection([feature()], { properties: { exceededTransferLimit: true } }),
    ),
  );
  const cameras = await loadSeattleSourcesFromOpenData();
  assert.equal(cameras.length, 1, 'the rows that did arrive still load');
  assert.ok(warnings.some((w) => /truncated/.test(w)));
});

test('CCTV_SEATTLE_MAX_SOURCES caps the pack, nearest downtown first', async (t) => {
  t.mock.method(console, 'log', () => {});
  const many = Array.from({ length: 20 }, (_, i) =>
    feature(
      {
        UNITID: `CMR-${String(i).padStart(4, '0')}`,
        URL: `https://www.seattle.gov/trafficcams/images/cam${i}.jpg`,
      },
      // Each step further north of downtown.
      { type: 'Point', coordinates: [-122.3375, 47.6101 + i * 0.005] },
    ),
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(collection(many)),
  );
  const saved = process.env.CCTV_SEATTLE_MAX_SOURCES;
  process.env.CCTV_SEATTLE_MAX_SOURCES = '8';
  try {
    const cameras = await loadSeattleSourcesFromOpenData();
    assert.equal(cameras.length, 8);
    assert.deepEqual(
      cameras.map((c) => c.id).sort(),
      Array.from(
        { length: 8 },
        (_, i) => `sdot-cmr-${String(i).padStart(4, '0')}`,
      ),
    );
  } finally {
    if (saved === undefined) delete process.env.CCTV_SEATTLE_MAX_SOURCES;
    else process.env.CCTV_SEATTLE_MAX_SOURCES = saved;
  }
});

test('an upstream failure yields an empty pack and releases the response', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const failed = streamingResponse({ status: 503 });
  t.mock.method(globalThis, 'fetch', async () => failed.response);
  assert.deepEqual(await loadSeattleSourcesFromOpenData(), []);
  assert.equal(failed.state.cancelled, true, 'the failed body is cancelled');

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadSeattleSourcesFromOpenData(), []);
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const redirected = streamingResponse({
    status: 302,
    headers: { location: 'https://evil.example/cams.json' },
  });
  t.mock.method(globalThis, 'fetch', async () => redirected.response);
  assert.deepEqual(await loadSeattleSourcesFromOpenData(), []);
  assert.equal(
    redirected.state.cancelled,
    true,
    'the redirect body is cancelled',
  );

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(SEATTLE_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/geo+json' } },
    );
  });
  assert.deepEqual(await loadSeattleSourcesFromOpenData(), []);
});

/**
 * Serve the Seattle catalog to the Seattle endpoint and an empty payload to
 * every other pack, so one catalog refresh exercises the registration without
 * reaching the network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === DEFAULT_SEATTLE_CCTV_URL) {
      return Response.json(collection([feature()]));
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_SEATTLE_URL;
    delete process.env.CCTV_SEATTLE_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('the Seattle lane is wired into the catalog and its loader runs', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(requested.includes(DEFAULT_SEATTLE_CCTV_URL));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'seattle').map((s) => s.id),
      ['sdot-cmr-0270'],
    );
  });
});

test('CCTV_SEATTLE_ENABLED=0 keeps the lane from being loaded at all', async (t) => {
  await withEnv({ CCTV_SEATTLE_ENABLED: '0' }, async () => {
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(requested.includes(DEFAULT_SEATTLE_CCTV_URL), false);
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'seattle'),
      [],
    );
  });
});

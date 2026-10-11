import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  boxCenter,
  boxContainsPoint,
  boxInside,
  boxLatSpan,
  boxLonSpan,
  padBox,
  pickViewportEvictions,
} from './cctvViewportBox.js';
import { cameraIdHueIndex, createRecords } from '../layers/cctv/records.js';
import { createCctvSource } from '../layers/cctv/source.js';

const SEATTLE = { west: -122.5, south: 47.4, east: -122.2, north: 47.8 };
const PACIFIC = { west: 170, south: -20, east: -170, north: -10 };

test('spans and containment handle antimeridian-crossing boxes', () => {
  assert.ok(Math.abs(boxLonSpan(SEATTLE) - 0.3) < 1e-9);
  assert.ok(Math.abs(boxLatSpan(SEATTLE) - 0.4) < 1e-9);
  assert.equal(boxLonSpan(PACIFIC), 20);
  assert.equal(boxContainsPoint(PACIFIC, -15, 179), true);
  assert.equal(boxContainsPoint(PACIFIC, -15, -179), true);
  assert.equal(boxContainsPoint(PACIFIC, -15, 0), false);
  assert.equal(boxContainsPoint(SEATTLE, NaN, -122.3), false);
  assert.deepEqual(boxCenter(PACIFIC), { lat: -15, lon: 180 });
});

test('padding grows every side, clamps the poles and wraps longitude', () => {
  const padded = padBox(SEATTLE, 0.25);
  assert.ok(Math.abs(padded.west - -122.575) < 1e-9);
  assert.ok(Math.abs(padded.east - -122.125) < 1e-9);
  assert.ok(Math.abs(padded.south - 47.3) < 1e-9);
  assert.ok(Math.abs(padded.north - 47.9) < 1e-9);

  const polar = padBox({ west: 0, south: 80, east: 10, north: 89 }, 0.5);
  assert.equal(polar.north, 90);

  // Growing across ±180 produces a crossing box, not a wrong-way one.
  const edge = padBox({ west: 175, south: 0, east: 179, north: 2 }, 1);
  assert.equal(edge.west, 171);
  assert.equal(edge.east, -177);
  assert.equal(boxContainsPoint(edge, 1, -178), true);

  // A box that would wrap the world becomes the whole longitude range.
  assert.deepEqual(padBox({ west: -170, south: 0, east: 170, north: 1 }, 0.1), {
    west: -180,
    south: -0.1,
    east: 180,
    north: 1.1,
  });
});

test('a small pan stays inside the padded box already fetched', () => {
  const fetched = padBox(SEATTLE, 0.25);
  const panned = {
    west: SEATTLE.west + 0.05,
    south: SEATTLE.south,
    east: SEATTLE.east + 0.05,
    north: SEATTLE.north,
  };
  assert.equal(boxInside(panned, fetched), true);
  const farPan = { ...panned, west: -121.9, east: -121.6 };
  assert.equal(boxInside(farPan, fetched), false);
  assert.equal(boxInside(SEATTLE, null), false);
  // Antimeridian on both sides.
  assert.equal(
    boxInside({ west: 178, south: -15, east: -178, north: -12 }, PACIFIC),
    true,
  );
  assert.equal(
    boxInside({ west: -175, south: -15, east: -165, north: -12 }, PACIFIC),
    false,
  );
});

const rec = (id, lat, lon, tier = 'viewport') => ({
  tier,
  camera: { id, lat, lon },
});
const flatDistance = (a, b) => Math.hypot(a.lat - b.lat, a.lon - b.lon);

test('eviction drops the farthest viewport records, never in-view, protected or catalog ones', () => {
  const view = { west: 0, south: 0, east: 1, north: 1 };
  const records = [
    rec('cat-far', 50, 50, 'catalog'),
    rec('in-view', 0.5, 0.5),
    rec('near', 2, 2),
    rec('mid', 5, 5),
    rec('far', 20, 20),
    rec('active-far', 30, 30),
  ];
  const evict = pickViewportEvictions(records, {
    box: view,
    max: 3,
    protectedIds: new Set(['active-far']),
    distance: flatDistance,
  });
  assert.deepEqual(
    evict.map((r) => r.camera.id),
    ['far', 'mid'],
  );
  // Under the cap nothing goes.
  assert.deepEqual(
    pickViewportEvictions(records, {
      box: view,
      max: 10,
      distance: flatDistance,
    }),
    [],
  );
  // When everything left is in view or protected, fewer than the excess go.
  assert.deepEqual(
    pickViewportEvictions([rec('a', 0.1, 0.1), rec('b', 0.2, 0.2)], {
      box: view,
      max: 0,
      distance: flatDistance,
    }),
    [],
  );
});

test('viewport hues come from the id alone', () => {
  assert.equal(
    cameraIdHueIndex('sdot-cmr-0270'),
    cameraIdHueIndex('sdot-cmr-0270'),
  );
  assert.notEqual(cameraIdHueIndex('a'), cameraIdHueIndex('b'));
  assert.ok(
    Number.isInteger(cameraIdHueIndex('')) && cameraIdHueIndex('') >= 0,
  );
});

/** A records part over real Cesium collections and minimal collaborators. */
function makeRecords() {
  const entities = new Cesium.EntityCollection();
  const destroyedRuntimes = [];
  const destroyedVolumes = [];
  const state = {
    _viewer: { entities },
    _billboards: new Cesium.BillboardCollection(),
    _records: [],
    _recordById: new Map(),
    _coverageEntities: [],
    _projectionEntities: [],
    _geoQueue: [],
    _cardIds: new Set(),
    _cardGraceState: new Map(),
    _cardFrameSlots: new Map(),
    _calibrationById: new Map(),
    _count: 0,
  };
  const parts = {
    calibration: {
      migrateRangeScaleForFloor: (values) => values,
      normalizeCalibration: (values) => values,
    },
    model: { ensureCameraPose() {} },
    geometry: {
      destroyViewshedVolume(record) {
        if (record.viewshedPrimitive) destroyedVolumes.push(record.camera.id);
        record.viewshedPrimitive = null;
      },
    },
    projection: {
      destroyProjectionRuntime(runtime) {
        destroyedRuntimes.push(runtime);
      },
    },
  };
  return {
    state,
    records: createRecords({ state, parts }),
    entities,
    destroyedRuntimes,
    destroyedVolumes,
  };
}

const camera = (id, lat = 47.6, lon = -122.3) => ({
  id,
  name: id,
  lat,
  lon,
  mountHeightM: 8,
  groundElevationM: 60,
});

test('removing a viewport record leaves nothing it owned behind', () => {
  const ctx = makeRecords();
  const { state, records, entities } = ctx;
  const keep = records.addRecord(camera('catalog-1'), {
    groundPrior: null,
    hueIndex: 0,
  });
  const gone = records.addRecord(camera('viewport-1'), {
    groundPrior: { ellipsoid: 40, source: 'test' },
    hueIndex: cameraIdHueIndex('viewport-1'),
    tier: 'viewport',
  });
  assert.equal(keep.tier, 'catalog');
  assert.equal(gone.tier, 'viewport');
  assert.equal(gone.camera.absoluteHeightM, 48, 'prior + mount height');
  assert.equal(state._billboards.length, 2);
  assert.equal(state._count, 2);

  // Give the viewport record one of everything a live record can own.
  const ownEntity = entities.add({ id: 'cctv-viewport-1-cap' });
  const otherEntity = entities.add({ id: 'cctv-catalog-1-cap' });
  gone.coverageEntities = [ownEntity];
  keep.coverageEntities = [otherEntity];
  state._coverageEntities = [ownEntity, otherEntity];
  gone.viewshedPrimitive = {};
  gone.projection = { cameraId: 'viewport-1' };
  state._projectionEntities = [gone.projection, { cameraId: 'catalog-1' }];
  state._geoQueue = [keep, gone];
  state._cardIds.add('viewport-1');
  state._cardGraceState.set('viewport-1', {});
  state._cardFrameSlots.set('viewport-1', {});

  records.removeRecord(gone);

  assert.equal(state._billboards.length, 1);
  assert.equal(state._records.length, 1);
  assert.equal(state._count, 1);
  assert.equal(state._recordById.has('viewport-1'), false);
  assert.equal(state._recordById.get('catalog-1'), keep);
  assert.equal(entities.getById('cctv-viewport-1-cap'), undefined);
  assert.ok(
    entities.getById('cctv-catalog-1-cap'),
    'a neighbour keeps its entity',
  );
  assert.deepEqual(state._coverageEntities, [otherEntity]);
  assert.deepEqual(ctx.destroyedVolumes, ['viewport-1']);
  assert.equal(ctx.destroyedRuntimes.length, 1);
  assert.deepEqual(
    state._projectionEntities.map((r) => r.cameraId),
    ['catalog-1'],
  );
  assert.deepEqual(state._geoQueue, [keep]);
  assert.equal(state._cardIds.has('viewport-1'), false);
  assert.equal(state._cardGraceState.has('viewport-1'), false);
  assert.equal(state._cardFrameSlots.has('viewport-1'), false);

  // Removing it again, or a record that was never registered, is a no-op.
  records.removeRecord(gone);
  records.removeRecord({ camera: { id: 'ghost' } });
  assert.equal(state._records.length, 1);
});

test('the source asks for a viewport with a bbox query and passes the global request through', async () => {
  const urls = [];
  const source = createCctvSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({ sources: [] });
    },
  });
  await source.getCatalog();
  await source.getCatalog({
    bbox: { west: 170, south: -20, east: -170, north: -10 },
    limit: 1500.7,
  });
  assert.equal(urls[0], '/api/cctv/sources');
  const viewport = new URL(urls[1], 'http://localhost');
  assert.equal(viewport.pathname, '/api/cctv/sources');
  assert.equal(
    viewport.searchParams.get('bbox'),
    '170.00000,-20.00000,-170.00000,-10.00000',
  );
  assert.equal(viewport.searchParams.get('limit'), '1500');
});

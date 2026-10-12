import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLIGHT_BOOST,
  MAX_FLIGHT_SPEED_MPS,
  MIN_FLIGHT_CLEARANCE_M,
  MIN_FLIGHT_SPEED_MPS,
  flightAxes,
  flightAxisForCode,
  flightSpeedMps,
  planFlightStep,
} from './keyboardFlightMath.js';

const DEG = Math.PI / 180;
const pose = (overrides = {}) => ({
  longitude: 0,
  latitude: 0,
  height: 1_000,
  heading: 0,
  groundHeight: 0,
  dtSec: 0.05,
  ...overrides,
});
const axes = (overrides = {}) => ({
  forward: 0,
  right: 0,
  up: 0,
  turn: 0,
  ...overrides,
});

test('WASD, R and F fly only in fly mode; arrows, Q, E and paging always fly', () => {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF']) {
    assert.equal(flightAxisForCode(code, false), null, code);
    assert.ok(flightAxisForCode(code, true), code);
  }
  for (const code of [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'KeyQ',
    'KeyE',
    'PageUp',
    'PageDown',
  ]) {
    assert.ok(flightAxisForCode(code, false), code);
    assert.deepEqual(
      flightAxisForCode(code, false),
      flightAxisForCode(code, true),
    );
  }
  assert.equal(flightAxisForCode('KeyH', true), null);
  assert.equal(flightAxisForCode('Space', true), null);
});

test('held keys sum per axis, cancel when opposed and never exceed one', () => {
  assert.deepEqual(
    flightAxes(['KeyW', 'ArrowUp', 'KeyD', 'KeyQ'], true),
    axes({ forward: 1, right: 1, turn: -1 }),
  );
  assert.deepEqual(flightAxes(['ArrowUp', 'ArrowDown'], false), axes());
  assert.deepEqual(flightAxes(['KeyW', 'KeyD'], false), axes());
});

test('speed follows clearance between a floor and a ceiling, and Shift boosts it', () => {
  assert.equal(flightSpeedMps(0), MIN_FLIGHT_SPEED_MPS);
  assert.equal(flightSpeedMps(Number.NaN), MIN_FLIGHT_SPEED_MPS);
  assert.equal(flightSpeedMps(2_000), 2_000);
  assert.equal(flightSpeedMps(2_000, true), 2_000 * FLIGHT_BOOST);
  assert.equal(flightSpeedMps(1e9), MAX_FLIGHT_SPEED_MPS);
  assert.equal(flightSpeedMps(1e9, true), MAX_FLIGHT_SPEED_MPS);
});

test('no held axis or an invalid pose moves nothing', () => {
  assert.equal(planFlightStep({ ...pose(), axes: axes() }), null);
  assert.equal(
    planFlightStep({
      ...pose({ height: Number.NaN }),
      axes: axes({ forward: 1 }),
    }),
    null,
  );
  assert.equal(
    planFlightStep({ ...pose({ dtSec: 0 }), axes: axes({ forward: 1 }) }),
    null,
  );
});

test('forward follows the heading along the ground and keeps height', () => {
  const north = planFlightStep({ ...pose(), axes: axes({ forward: 1 }) });
  assert.ok(north.latitude > 0);
  assert.ok(Math.abs(north.longitude) < 1e-12);
  assert.equal(north.height, 1_000);

  const east = planFlightStep({
    ...pose({ heading: 90 * DEG }),
    axes: axes({ forward: 1 }),
  });
  assert.ok(east.longitude > 0);
  assert.ok(Math.abs(east.latitude) < 1e-12);
});

test('strafing right is a quarter turn clockwise from forward', () => {
  const step = planFlightStep({ ...pose(), axes: axes({ right: 1 }) });
  assert.ok(step.longitude > 0);
  assert.ok(Math.abs(step.latitude) < 1e-12);
  const left = planFlightStep({
    ...pose({ heading: 90 * DEG }),
    axes: axes({ right: -1 }),
  });
  assert.ok(left.latitude > 0);
});

test('one frame covers speed times the clamped frame time', () => {
  const step = planFlightStep({
    ...pose({ dtSec: 0.05 }),
    axes: axes({ forward: 1 }),
  });
  const metres = step.latitude * (6_371_000 + 1_000);
  assert.ok(Math.abs(metres - 1_000 * 0.05) < 1e-6);
  const stalled = planFlightStep({
    ...pose({ dtSec: 5 }),
    axes: axes({ forward: 1 }),
  });
  const stalledMetres = stalled.latitude * (6_371_000 + 1_000);
  assert.ok(Math.abs(stalledMetres - 1_000 * 0.1) < 1e-6);
});

test('descending stops at the minimum clearance above the ground', () => {
  const step = planFlightStep({
    ...pose({ height: 511, groundHeight: 500, dtSec: 0.1 }),
    axes: axes({ up: -1 }),
  });
  assert.equal(step.height, 500 + MIN_FLIGHT_CLEARANCE_M);
  const climb = planFlightStep({ ...pose(), axes: axes({ up: 1 }) });
  assert.ok(climb.height > 1_000);
});

test('turning wraps the heading and leaves position alone', () => {
  const step = planFlightStep({
    ...pose({ heading: 359 * DEG }),
    axes: axes({ turn: 1 }),
  });
  assert.ok(step.heading >= 0 && step.heading < 5 * DEG);
  assert.equal(step.latitude, 0);
  assert.equal(step.longitude, 0);
  assert.equal(step.height, 1_000);
});

test('the pole and the antimeridian stay in range', () => {
  const pole = planFlightStep({
    ...pose({ latitude: 89.49 * DEG, height: 1e7, dtSec: 0.1 }),
    axes: axes({ forward: 1 }),
  });
  assert.ok(pole.latitude <= 89.5 * DEG + 1e-12);
  const wrap = planFlightStep({
    ...pose({ longitude: 179.9999 * DEG, heading: 90 * DEG, height: 1e5 }),
    axes: axes({ forward: 1 }),
  });
  assert.ok(wrap.longitude < 0 && wrap.longitude >= -Math.PI);
});

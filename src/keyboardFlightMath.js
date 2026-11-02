/**
 * Pure step math for held-key camera flight.
 *
 * Movement is planned in geodetic coordinates so a held key glides along the
 * curved surface at a constant height instead of a straight tangent line that
 * climbs away from the globe. Forward follows the camera heading projected on
 * the ground, so a downward-pitched view never dives into terrain.
 */

const EARTH_RADIUS_M = 6_371_000;
const MAX_STEP_SEC = 0.1;
const MAX_LATITUDE_RAD = (89.5 * Math.PI) / 180;
const TURN_RATE_RAD_PER_SEC = Math.PI / 3;

export const MIN_FLIGHT_CLEARANCE_M = 10;
export const MIN_FLIGHT_SPEED_MPS = 15;
export const MAX_FLIGHT_SPEED_MPS = 3_000_000;
export const FLIGHT_BOOST = 5;

/** Keys that fly the camera whenever the globe has keyboard focus. */
export const ALWAYS_ON_FLIGHT_KEYS = Object.freeze({
  ArrowUp: ['forward', 1],
  ArrowDown: ['forward', -1],
  ArrowRight: ['right', 1],
  ArrowLeft: ['right', -1],
  KeyE: ['turn', 1],
  KeyQ: ['turn', -1],
  PageUp: ['up', 1],
  PageDown: ['up', -1],
});

/**
 * Keys that fly the camera only while fly mode is on. Matched by
 * `KeyboardEvent.code`, so they keep their physical positions on any layout.
 */
export const FLY_MODE_FLIGHT_KEYS = Object.freeze({
  KeyW: ['forward', 1],
  KeyS: ['forward', -1],
  KeyD: ['right', 1],
  KeyA: ['right', -1],
  KeyR: ['up', 1],
  KeyF: ['up', -1],
});

/**
 * Resolve one physical key to its flight axis, or null when it does not fly.
 * @param {string} code `KeyboardEvent.code`.
 * @param {boolean} flyMode Whether fly mode is on.
 * @returns {[string, number]|null} Axis name and direction.
 */
export function flightAxisForCode(code, flyMode) {
  return (
    ALWAYS_ON_FLIGHT_KEYS[code] ||
    (flyMode ? FLY_MODE_FLIGHT_KEYS[code] : null) ||
    null
  );
}

/**
 * Sum the held keys into clamped axes. Opposite keys cancel.
 * @param {Iterable<string>} codes Held `KeyboardEvent.code` values.
 * @param {boolean} flyMode Whether fly mode is on.
 * @returns {{forward: number, right: number, up: number, turn: number}}
 */
export function flightAxes(codes, flyMode) {
  const axes = { forward: 0, right: 0, up: 0, turn: 0 };
  for (const code of codes) {
    const binding = flightAxisForCode(code, flyMode);
    if (binding) axes[binding[0]] += binding[1];
  }
  for (const name of Object.keys(axes))
    axes[name] = Math.max(-1, Math.min(1, axes[name]));
  return axes;
}

/**
 * Translation speed for a camera at this height above the ground: roughly one
 * altitude per second, so the same key feels the same at street level and
 * from orbit.
 * @param {number} heightAboveGroundM Camera clearance.
 * @param {boolean} [boost=false] Whether Shift is held.
 * @returns {number} Metres per second.
 */
export function flightSpeedMps(heightAboveGroundM, boost = false) {
  const height = Number.isFinite(heightAboveGroundM) ? heightAboveGroundM : 0;
  const base = Math.max(
    MIN_FLIGHT_SPEED_MPS,
    Math.min(MAX_FLIGHT_SPEED_MPS, height),
  );
  return boost ? Math.min(MAX_FLIGHT_SPEED_MPS, base * FLIGHT_BOOST) : base;
}

/**
 * Advance a camera pose by one frame of held-key flight.
 * @param {object} options
 * @param {number} options.longitude Radians.
 * @param {number} options.latitude Radians.
 * @param {number} options.height Ellipsoidal metres.
 * @param {number} options.heading Radians, clockwise from north.
 * @param {number} [options.groundHeight=0] Surface height under the camera.
 * @param {number} [options.speedGroundHeight] Surface height that sets the
 * speed; a smoothed reading keeps a rooftop under the camera from jerking it.
 * Defaults to `groundHeight`.
 * @param {{forward: number, right: number, up: number, turn: number}} options.axes
 * @param {number} options.dtSec Frame time; long stalls are clamped.
 * @param {boolean} [options.boost=false] Whether Shift is held.
 * @param {number} [options.liftSec=0] When a higher surface turns up under a
 * camera already below the floor, rise to it over about this long instead of
 * snapping. Descent always stops at the floor.
 * @returns {{longitude: number, latitude: number, height: number, heading: number}|null}
 * The next pose, or null when nothing moves.
 */
export function planFlightStep({
  longitude,
  latitude,
  height,
  heading,
  groundHeight = 0,
  speedGroundHeight = groundHeight,
  axes,
  dtSec,
  boost = false,
  liftSec = 0,
}) {
  if (
    ![longitude, latitude, height, heading, dtSec].every(Number.isFinite) ||
    dtSec <= 0 ||
    !axes
  )
    return null;
  const { forward = 0, right = 0, up = 0, turn = 0 } = axes;
  if (!forward && !right && !up && !turn) return null;
  const dt = Math.min(MAX_STEP_SEC, dtSec);
  const ground = Number.isFinite(groundHeight) ? groundHeight : 0;
  const speedGround = Number.isFinite(speedGroundHeight)
    ? speedGroundHeight
    : ground;
  const distance = flightSpeedMps(height - speedGround, boost) * dt;

  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const east = distance * (forward * sin + right * cos);
  const north = distance * (forward * cos - right * sin);
  const radius = EARTH_RADIUS_M + Math.max(0, height);
  const nextLatitude = Math.max(
    -MAX_LATITUDE_RAD,
    Math.min(MAX_LATITUDE_RAD, latitude + north / radius),
  );
  const nextLongitude =
    longitude + east / (radius * Math.max(Math.cos(latitude), 1e-3));
  const floor = ground + MIN_FLIGHT_CLEARANCE_M;
  let nextHeight = height + up * distance;
  if (nextHeight < floor)
    nextHeight =
      height >= floor || !(liftSec > 0)
        ? floor
        : Math.max(
            nextHeight,
            height + (floor - height) * Math.min(1, dt / liftSec),
          );
  const nextHeading = heading + turn * TURN_RATE_RAD_PER_SEC * dt;
  const TWO_PI = Math.PI * 2;
  return {
    longitude:
      ((((nextLongitude + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI,
    latitude: nextLatitude,
    height: nextHeight,
    heading: ((nextHeading % TWO_PI) + TWO_PI) % TWO_PI,
  };
}

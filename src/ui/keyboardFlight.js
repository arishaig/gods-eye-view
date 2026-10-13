import * as Cesium from 'cesium';
import {
  flightAxes,
  flightAxisForCode,
  planFlightStep,
} from '../keyboardFlightMath.js';

const RENDER_OWNER = 'keyboard-flight';
const FLY_MODE_KEY = 'g';
const GROUND_SAMPLE_MS = 200;
/** Time constant for the ground reading that sets speed. */
const SPEED_GROUND_SMOOTHING_SEC = 0.4;
/** How long a newly found higher floor takes to lift the camera. */
const FLOOR_LIFT_SEC = 0.25;
const EDITING_SELECTOR = 'input, textarea, select, [contenteditable]';

/**
 * Whether a key event is aimed at the globe rather than a control. Focused
 * widgets (sliders, tabs, carousels, open surfaces) keep their arrow keys.
 */
function targetsGlobe(event, documentRef, canvas) {
  const target = event.target;
  return (
    !target ||
    target === documentRef ||
    target === documentRef.body ||
    target === documentRef.documentElement ||
    target === canvas
  );
}

/** Whether a key event belongs to text editing, which keeps every letter. */
function targetsEditing(event) {
  const target = event.target;
  return (
    target?.isContentEditable === true ||
    Boolean(target?.closest?.(EDITING_SELECTOR))
  );
}

/**
 * The photoreal tileset drawing the world, or null on the OSM fallback. Duck
 * typed (like the ground snap's tile check) so a fake scene can stand in.
 * @param {Cesium.Scene} scene Live scene.
 * @returns {Cesium.Cesium3DTileset|null}
 */
export function findPhotorealTileset(scene) {
  const primitives = scene?.primitives;
  if (!primitives?.get) return null;
  for (let i = 0; i < primitives.length; i++) {
    const primitive = primitives.get(i);
    if (
      primitive?.show !== false &&
      !primitive?.isDestroyed?.() &&
      typeof primitive?.getHeight === 'function' &&
      typeof primitive?.cullRequestsWhileMoving === 'boolean'
    )
      return primitive;
  }
  return null;
}

/**
 * Read the highest known surface under the camera. Photoreal tiles hide the
 * globe, so `globe.getHeight()` alone would put the floor at sea level
 * (Denver's ground is ~1,600 m above it). The tileset's own `getHeight()`
 * ray-casts the tiles already loaded on the CPU; `scene.sampleHeight()` would
 * render a pick pass and pull tile loading toward the probe, a visible hitch
 * several times a second, so it is only the fallback when no tileset answers.
 * Like the camera ground guard, the floor is the highest reading (a coarse
 * surface can answer far below the terrain), and the last reading stands when
 * nothing answers.
 * @param {Cesium.Scene} scene Live scene.
 * @param {() => number} nowMs Clock in milliseconds.
 * @param {number} [intervalMs] Minimum time between tile samples.
 * @param {() => Cesium.Cesium3DTileset|null} [getTileset] Tileset to ray-cast.
 * @returns {{read: (cartographic: Cesium.Cartographic) => number, reset: () => void}}
 */
export function createGroundReader(
  scene,
  nowMs,
  intervalMs = GROUND_SAMPLE_MS,
  getTileset = () => findPhotorealTileset(scene),
) {
  let sampledAt = -Infinity;
  let tilesM = Number.NaN;
  let groundM = Number.NaN;
  const sampleTiles = (cartographic) => {
    try {
      const height = getTileset()?.getHeight(cartographic, scene);
      if (Number.isFinite(height)) return height;
    } catch {
      /* tiles not streamed under this point yet */
    }
    if (scene.sampleHeightSupported === false) return Number.NaN;
    try {
      const height = scene.sampleHeight?.(cartographic);
      if (Number.isFinite(height)) return height;
    } catch {
      /* tiles not streamed under this point yet */
    }
    return Number.NaN;
  };
  return {
    read(cartographic) {
      const now = nowMs();
      if (now - sampledAt >= intervalMs) {
        sampledAt = now;
        tilesM = sampleTiles(cartographic);
      }
      const readings = [scene.globe?.getHeight?.(cartographic), tilesM].filter(
        Number.isFinite,
      );
      if (readings.length) groundM = Math.max(...readings);
      return groundM;
    },
    reset() {
      sampledAt = -Infinity;
      tilesM = Number.NaN;
      groundM = Number.NaN;
    },
  };
}

/**
 * Tileset settings that keep tiles streaming while the camera never stops.
 * Cesium drops requests for tiles it expects to fly past and defers the
 * periphery during motion; a held key is all motion, so without these the
 * view only fills in after the key is let go.
 */
const STREAMING_WHILE_FLYING = Object.freeze({
  cullRequestsWhileMoving: false,
  foveatedTimeDelay: 0,
  loadSiblings: true,
});

/**
 * Apply flight streaming settings to a tileset and return a restore function.
 * @param {Cesium.Cesium3DTileset|null} tileset Tileset to tune.
 * @returns {() => void} Puts the saved values back.
 */
export function streamWhileFlying(tileset) {
  if (!tileset) return () => {};
  const saved = {};
  for (const [name, value] of Object.entries(STREAMING_WHILE_FLYING)) {
    if (!(name in tileset)) continue;
    saved[name] = tileset[name];
    tileset[name] = value;
  }
  return () => {
    if (tileset.isDestroyed?.()) return;
    Object.assign(tileset, saved);
  };
}

/**
 * Fly the camera with held keys. Arrows, Q/E and Page Up/Down always fly; G
 * toggles fly mode, which adds W/A/S/D and R/F and shadows the D and F
 * application shortcuts until it is turned off. Letter keys and Escape follow
 * the application shortcuts and yield only to text editing, so a focused
 * button never lets a fly-mode D reach Detection; arrows and paging fly only
 * when the globe itself is the target, so focused widgets keep them.
 *
 * The listener sits on the root element in the bubbling phase: capture-phase
 * surfaces keep first refusal, and it still runs before the document-level
 * application shortcuts so a claimed key never also toggles a panel.
 *
 * @param {object} options
 * @param {Cesium.Viewer} options.viewer Viewer whose camera flies.
 * @param {Document} [options.documentRef] Keyboard event source.
 * @param {Window} [options.windowRef] Blur and timing source.
 * @param {() => boolean} options.beginFlight Take camera authority for a new
 * gesture; false refuses it.
 * @param {(listener: Function) => Function} [options.subscribeCameraHandoff]
 * Ownership changes made by anything else end the gesture.
 * @param {(owner: string) => void} [options.holdContinuousRender]
 * @param {(owner: string) => void} [options.releaseContinuousRender]
 * @param {(message: string) => void} [options.showToast]
 * @returns {{isFlyMode: Function, setFlyMode: Function, stop: Function, destroy: Function}}
 */
export function bindKeyboardFlight({
  viewer,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  beginFlight,
  subscribeCameraHandoff,
  holdContinuousRender = () => {},
  releaseContinuousRender = () => {},
  showToast,
}) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  const canvas = scene.canvas;
  const keyRoot = documentRef.documentElement;
  const held = new Set();
  const removers = [];
  let flyMode = false;
  let boost = false;
  let claiming = false;
  let lastFrameMs = null;
  let speedGroundM = Number.NaN;
  let destroyed = false;

  const nowMs = () => windowRef?.performance?.now?.() ?? Date.now();
  const ground = createGroundReader(scene, nowMs);
  const inputsEnabled = () =>
    scene.screenSpaceCameraController?.enableInputs !== false;

  let restoreStreaming = null;

  const stop = () => {
    held.clear();
    lastFrameMs = null;
    restoreStreaming?.();
    restoreStreaming = null;
    releaseContinuousRender(RENDER_OWNER);
  };

  const setFlyMode = (on, { announce = true } = {}) => {
    const next = Boolean(on) && !destroyed;
    if (next === flyMode) return flyMode;
    flyMode = next;
    if (!flyMode) {
      for (const code of [...held])
        if (!flightAxisForCode(code, false)) held.delete(code);
      if (!held.size) stop();
    }
    documentRef.body?.classList?.toggle('keyboard-fly-mode', flyMode);
    if (announce)
      showToast?.(
        flyMode
          ? 'Fly mode: WASD move, Q/E turn, R/F climb, Shift faster. G or Esc exits'
          : 'Fly mode off',
      );
    return flyMode;
  };

  const onKeyDown = (event) => {
    boost = event.shiftKey;
    if (destroyed || event.defaultPrevented || event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const letterLike = /^Key[A-Z]$/.test(event.code) || event.key === 'Escape';
    if (
      letterLike
        ? targetsEditing(event)
        : !targetsGlobe(event, documentRef, canvas)
    )
      return;

    if (event.key === 'Escape') {
      if (flyMode) setFlyMode(false);
      return;
    }
    if (event.key?.toLowerCase() === FLY_MODE_KEY) {
      event.preventDefault();
      if (!event.repeat) setFlyMode(!flyMode);
      return;
    }

    if (!flightAxisForCode(event.code, flyMode)) return;
    // Claimed even when refused, so a fly-mode D never falls through to the
    // Detection shortcut and an arrow never scrolls the page.
    event.preventDefault();
    if (held.has(event.code)) return;
    if (!held.size) {
      // Cesium switches inputs off for the length of a flyTo; like a drag, a
      // key cancels that flight. Inputs still off mean a tool owns the camera.
      if (!inputsEnabled()) camera.cancelFlight?.();
      if (!inputsEnabled()) return;
      claiming = true;
      let granted = false;
      try {
        granted = beginFlight() !== false;
      } finally {
        claiming = false;
      }
      if (!granted) return;
      // The clock starts at the key press, so even a tap on a slow frame moves.
      lastFrameMs = nowMs();
      ground.reset();
      speedGroundM = Number.NaN;
      restoreStreaming = streamWhileFlying(findPhotorealTileset(scene));
      holdContinuousRender(RENDER_OWNER);
    }
    held.add(event.code);
  };

  const onKeyUp = (event) => {
    boost = event.shiftKey;
    if (!held.delete(event.code)) return;
    if (!held.size) stop();
  };

  const onFrame = () => {
    if (destroyed || !held.size) return;
    if (!inputsEnabled()) {
      stop();
      return;
    }
    const now = nowMs();
    const dtSec = lastFrameMs === null ? 0 : (now - lastFrameMs) / 1000;
    lastFrameMs = now;
    if (!dtSec) return;

    const cartographic = Cesium.Cartographic.fromCartesian(camera.positionWC);
    if (!cartographic) return;
    // The floor reading steps a few times a second and jumps at every
    // rooftop; speed follows a smoothed copy so the glide stays even.
    const groundM = ground.read(cartographic);
    if (Number.isFinite(groundM))
      speedGroundM = Number.isFinite(speedGroundM)
        ? speedGroundM +
          (groundM - speedGroundM) *
            Math.min(1, dtSec / SPEED_GROUND_SMOOTHING_SEC)
        : groundM;
    const next = planFlightStep({
      longitude: cartographic.longitude,
      latitude: cartographic.latitude,
      height: cartographic.height,
      heading: camera.heading,
      groundHeight: groundM,
      speedGroundHeight: speedGroundM,
      axes: flightAxes(held, flyMode),
      dtSec,
      boost,
      liftSec: FLOOR_LIFT_SEC,
    });
    if (!next) return;
    camera.setView({
      destination: Cesium.Cartesian3.fromRadians(
        next.longitude,
        next.latitude,
        next.height,
      ),
      orientation: { heading: next.heading, pitch: camera.pitch, roll: 0 },
    });
  };

  const listen = (target, type, handler) => {
    target?.addEventListener?.(type, handler);
    removers.push(() => target?.removeEventListener?.(type, handler));
  };
  listen(keyRoot, 'keydown', onKeyDown);
  // Releases are read on the document so a key let go over a control still ends.
  listen(documentRef, 'keyup', onKeyUp);
  listen(windowRef, 'blur', stop);
  listen(documentRef, 'visibilitychange', () => {
    if (documentRef.visibilityState === 'hidden') stop();
  });
  const removeFrame = scene.preRender?.addEventListener?.(onFrame);
  if (typeof removeFrame === 'function') removers.push(removeFrame);
  const unsubscribeHandoff = subscribeCameraHandoff?.(() => {
    // Our own stamp publishes too; anything else (search, Director, voice,
    // tracking) now owns the camera and the held keys yield to it.
    if (!claiming && held.size) stop();
  });
  if (typeof unsubscribeHandoff === 'function')
    removers.push(unsubscribeHandoff);

  return {
    isFlyMode: () => flyMode,
    setFlyMode,
    stop,
    destroy() {
      if (destroyed) return;
      setFlyMode(false, { announce: false });
      destroyed = true;
      stop();
      for (const remove of removers.splice(0)) remove();
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { bindKeyboardFlight, createGroundReader } from './keyboardFlight.js';
import { bindApplicationShortcuts } from './visualInput.js';

class Target extends EventTarget {
  constructor(tagName = 'DIV') {
    super();
    this.tagName = tagName;
  }
  closest(selector) {
    return selector.includes('input') &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName)
      ? this
      : null;
  }
  matches(selector) {
    return (
      selector === 'select, input, textarea' &&
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName)
    );
  }
}

function fixture({ grant = true, enableInputs = true } = {}) {
  const documentRef = new Target('#document');
  const root = new Target('HTML');
  const body = new Target('BODY');
  const classes = new Set();
  body.classList = {
    toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
  };
  Object.assign(documentRef, {
    documentElement: root,
    body,
    visibilityState: 'visible',
  });
  const windowRef = new EventTarget();
  let nowMs = 1_000;
  windowRef.performance = { now: () => nowMs };

  const preRender = new Cesium.Event();
  const views = [];
  const camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1_000),
    heading: 0,
    pitch: Cesium.Math.toRadians(-30),
    setView(view) {
      views.push(view);
      this.positionWC = view.destination;
      this.heading = view.orientation.heading;
    },
  };
  const canvas = new Target('CANVAS');
  const scene = {
    canvas,
    preRender,
    globe: { getHeight: () => 0 },
    screenSpaceCameraController: { enableInputs },
  };
  const calls = [];
  const handoffListeners = new Set();
  const controller = bindKeyboardFlight({
    viewer: { scene, camera },
    documentRef,
    windowRef,
    beginFlight: () => {
      calls.push('begin');
      for (const listener of handoffListeners) listener();
      return grant;
    },
    subscribeCameraHandoff: (listener) => {
      handoffListeners.add(listener);
      return () => handoffListeners.delete(listener);
    },
    holdContinuousRender: (owner) => calls.push(['hold', owner]),
    releaseContinuousRender: (owner) => calls.push(['release', owner]),
    showToast: (message) => calls.push(['toast', message]),
  });
  // Events bubble from the target through <html> to the document.
  const dispatch = (type, init, target = body) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      key: '',
      code: '',
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      ...init,
    });
    Object.defineProperty(event, 'target', { value: target });
    if (target !== root && target !== documentRef) target.dispatchEvent(event);
    root.dispatchEvent(event);
    documentRef.dispatchEvent(event);
    return event;
  };
  const press = (code, key = code, target, extra = {}) =>
    dispatch('keydown', { code, key, ...extra }, target);
  const release = (code, key = code) => dispatch('keyup', { code, key });
  const frame = (ms = 50) => {
    nowMs += ms;
    preRender.raiseEvent();
  };
  const handoff = () => {
    for (const listener of handoffListeners) listener();
  };
  return {
    controller,
    documentRef,
    windowRef,
    body,
    canvas,
    camera,
    scene,
    classes,
    views,
    calls,
    press,
    release,
    frame,
    handoff,
  };
}

const latitudeOf = (cartesian) =>
  Cesium.Cartographic.fromCartesian(cartesian).latitude;

test('a held arrow takes the camera once and glides north each frame', () => {
  const f = fixture();
  const start = latitudeOf(f.camera.positionWC);
  const down = f.press('ArrowUp');
  assert.equal(down.defaultPrevented, true);
  f.press('ArrowUp', 'ArrowUp', f.body, { repeat: true });
  f.frame();
  f.frame();
  f.frame();
  assert.deepEqual(
    f.calls.filter((call) => call === 'begin'),
    ['begin'],
  );
  assert.deepEqual(f.calls[1], ['hold', 'keyboard-flight']);
  assert.equal(f.views.length, 3, 'the clock starts at the key press');
  assert.ok(latitudeOf(f.camera.positionWC) > start);
  assert.equal(f.views[0].orientation.pitch, f.camera.pitch);

  f.release('ArrowUp');
  assert.deepEqual(f.calls.at(-1), ['release', 'keyboard-flight']);
  f.frame();
  assert.equal(f.views.length, 3);
});

test('WASD does nothing until G turns fly mode on, and D stops reaching Detection', () => {
  const f = fixture();
  const detections = [];
  bindApplicationShortcuts({
    documentRef: f.documentRef,
    searchInput: new Target('INPUT'),
    actions: {
      setStyle() {},
      dismissSearch() {},
      toggleHud() {},
      toggleOrbit() {},
      toggleCleanView() {},
      toggleLayers: () => detections.push('layers'),
      cycleDetection: () => detections.push('detection'),
      toggleCctv() {},
    },
  });

  f.press('KeyD', 'd');
  f.press('KeyF', 'f');
  assert.deepEqual(detections, ['detection', 'layers']);
  assert.ok(!f.calls.includes('begin'));

  f.press('KeyG', 'g');
  assert.equal(f.controller.isFlyMode(), true);
  assert.ok(f.classes.has('keyboard-fly-mode'));
  assert.match(f.calls.at(-1)[1], /^Fly mode: WASD/);

  f.press('KeyD', 'd');
  f.press('KeyF', 'f');
  assert.deepEqual(detections, ['detection', 'layers']);
  assert.ok(f.calls.includes('begin'));
  f.frame();
  f.frame();
  assert.ok(f.views.length > 0);
});

test('Escape and G leave fly mode and drop held fly-mode keys', () => {
  const f = fixture();
  f.press('KeyG', 'g');
  f.press('KeyW', 'w');
  f.press('Escape');
  assert.equal(f.controller.isFlyMode(), false);
  assert.deepEqual(f.calls.at(-1), ['toast', 'Fly mode off']);
  assert.ok(f.calls.some((call) => call[0] === 'release'));
  f.frame();
  f.frame();
  assert.equal(f.views.length, 0);

  f.press('KeyG', 'g');
  f.press('KeyG', 'g');
  assert.equal(f.controller.isFlyMode(), false);
});

test('focused controls, modifiers and already-claimed keys keep their keys', () => {
  const f = fixture();
  const slider = new Target('INPUT');
  assert.equal(f.press('ArrowUp', 'ArrowUp', slider).defaultPrevented, false);
  assert.equal(
    f.press('ArrowUp', 'ArrowUp', f.body, { ctrlKey: true }).defaultPrevented,
    false,
  );
  assert.equal(f.press('KeyG', 'g', slider).defaultPrevented, false);
  assert.equal(f.controller.isFlyMode(), false);
  assert.ok(!f.calls.includes('begin'));

  f.press('ArrowUp', 'ArrowUp', f.canvas);
  assert.ok(f.calls.includes('begin'));
});

test('a focused button keeps arrows but not fly-mode letters', () => {
  const f = fixture();
  const detections = [];
  bindApplicationShortcuts({
    documentRef: f.documentRef,
    searchInput: new Target('INPUT'),
    actions: {
      setStyle() {},
      dismissSearch() {},
      toggleHud() {},
      toggleOrbit() {},
      toggleCleanView() {},
      toggleLayers() {},
      cycleDetection: () => detections.push('detection'),
      toggleCctv() {},
    },
  });
  const button = new Target('BUTTON');
  f.press('KeyG', 'g', button);
  assert.equal(f.controller.isFlyMode(), true);
  assert.equal(f.press('KeyD', 'd', button).defaultPrevented, true);
  assert.deepEqual(detections, []);
  assert.equal(f.press('ArrowUp', 'ArrowUp', button).defaultPrevented, false);
  f.press('Escape', 'Escape', button);
  assert.equal(f.controller.isFlyMode(), false);
  f.press('KeyD', 'd', button);
  assert.deepEqual(detections, ['detection']);
});

test('the ground reader floors on the highest surface and throttles tile samples', () => {
  let nowMs = 0;
  let tiles = 1_600;
  let globe;
  let samples = 0;
  const scene = {
    sampleHeight: () => {
      samples += 1;
      return tiles;
    },
    globe: { getHeight: () => globe },
  };
  const ground = createGroundReader(scene, () => nowMs, 200);
  const at = Cesium.Cartographic.fromDegrees(-104.99, 39.74);
  assert.equal(ground.read(at), 1_600, 'tiles when the globe is hidden');
  tiles = 1_700;
  nowMs = 100;
  assert.equal(ground.read(at), 1_600, 'tiles are cached between samples');
  nowMs = 250;
  assert.equal(ground.read(at), 1_700);
  assert.equal(samples, 2);

  // A coarse pick far below the terrain must not lower the floor.
  tiles = -2_210;
  globe = 152;
  nowMs = 500;
  assert.equal(ground.read(at), 152);
  globe = 160;
  nowMs = 510;
  assert.equal(ground.read(at), 160, 'the globe is read every frame');

  tiles = undefined;
  globe = undefined;
  nowMs = 800;
  assert.equal(ground.read(at), 160, 'last reading when nothing answers');
  ground.reset();
  assert.ok(Number.isNaN(ground.read(at)));

  const unsupported = createGroundReader(
    { sampleHeightSupported: false, sampleHeight: () => 9, globe: {} },
    () => 0,
  );
  assert.ok(Number.isNaN(unsupported.read(at)));
});

test('a refused gesture or a tool owning camera inputs never moves the camera', () => {
  const refused = fixture({ grant: false });
  assert.equal(refused.press('ArrowUp').defaultPrevented, true);
  refused.frame();
  refused.frame();
  assert.equal(refused.views.length, 0);
  assert.ok(!refused.calls.some((call) => call[0] === 'hold'));

  const locked = fixture({ enableInputs: false });
  locked.press('ArrowUp');
  locked.frame();
  assert.ok(!locked.calls.includes('begin'));
  assert.equal(locked.views.length, 0);

  const flying = fixture({ enableInputs: false });
  flying.camera.cancelFlight = () => {
    flying.scene.screenSpaceCameraController.enableInputs = true;
  };
  flying.press('ArrowUp');
  flying.frame();
  flying.frame();
  assert.ok(flying.calls.includes('begin'), 'a key cancels a Cesium flight');
  assert.equal(flying.views.length, 2);

  const owned = fixture();
  owned.press('ArrowUp');
  owned.frame();
  owned.scene.screenSpaceCameraController.enableInputs = false;
  owned.frame();
  owned.frame();
  assert.equal(
    owned.views.length,
    1,
    'only the frame before the tool took over',
  );
  assert.deepEqual(owned.calls.at(-1), ['release', 'keyboard-flight']);
});

test('another camera owner, window blur and a hidden tab end the gesture', () => {
  for (const end of [
    (f) => f.handoff(),
    (f) => f.windowRef.dispatchEvent(new Event('blur')),
    (f) => {
      f.documentRef.visibilityState = 'hidden';
      f.documentRef.dispatchEvent(new Event('visibilitychange'));
    },
  ]) {
    const f = fixture();
    f.press('ArrowUp');
    f.frame();
    end(f);
    f.frame();
    f.frame();
    assert.equal(f.views.length, 1, 'only the frame before the gesture ended');
    assert.deepEqual(f.calls.at(-1), ['release', 'keyboard-flight']);
  }
});

test('Shift boosts the glide and destroy removes every listener', () => {
  const slow = fixture();
  slow.press('ArrowUp');
  slow.frame();
  slow.frame();
  const fast = fixture();
  fast.press('ArrowUp', 'ArrowUp', fast.body, { shiftKey: true });
  fast.frame();
  fast.frame();
  assert.ok(
    latitudeOf(fast.camera.positionWC) > latitudeOf(slow.camera.positionWC),
  );

  const f = fixture();
  f.press('KeyG', 'g');
  f.controller.destroy();
  f.controller.destroy();
  assert.equal(f.classes.has('keyboard-fly-mode'), false);
  f.press('ArrowUp');
  f.frame();
  f.frame();
  assert.ok(!f.calls.includes('begin'));
  assert.equal(f.views.length, 0);
});

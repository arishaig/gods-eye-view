#!/usr/bin/env node
/**
 * Browser acceptance for held-key camera flight.
 *
 * Proves: arrows glide along the heading at a held height, Q/E turn, WASD and
 * R/F fly only in fly mode (G), where D and F stop reaching Detection and the
 * layer panel; Escape leaves fly mode; a focused slider keeps its arrows; a
 * keyboard gesture releases a tracked entity and interrupts a camera flight.
 *
 * Run against a dev server: QA_BASE_URL=http://127.0.0.1:4173 node scripts/qa-keyboard-flight.mjs
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` ${detail}` : ''}`,
  );
  if (!passed) failures += 1;
};
const pose = () =>
  page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const c = viewer.camera.positionCartographic;
    return {
      lat: (c.latitude * 180) / Math.PI,
      lon: (c.longitude * 180) / Math.PI,
      height: c.height,
      heading: (viewer.camera.heading * 180) / Math.PI,
    };
  });
const hold = async (key, ms = 1_500) => {
  await page.keyboard.down(key);
  await new Promise((resolve) => setTimeout(resolve, ms));
  await page.keyboard.up(key);
};
const moved = (a, b) =>
  Math.abs(a.lat - b.lat) > 1e-6 || Math.abs(a.lon - b.lon) > 1e-6;

try {
  await page.setViewport({ width: 1440, height: 900 });
  const url = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173');
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__godsEyeView?.styleManager?._keyboardFlight,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () => {
      const cover = document.getElementById('loading-screen');
      return (
        cover?.classList.contains('hidden') &&
        Number(getComputedStyle(cover).opacity) === 0
      );
    },
    { timeout: 60_000 },
  );
  // Settle any startup flight, then look north from where the app opened.
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: viewer.camera.positionWC.clone(),
      orientation: { heading: 0, pitch: -0.6, roll: 0 },
    });
    document.activeElement?.blur();
  });

  const start = await pose();
  await hold('ArrowUp');
  const forward = await pose();
  check(
    'held ArrowUp glides north at the same height',
    forward.lat > start.lat &&
      Math.abs(forward.height - start.height) < start.height * 0.05,
    JSON.stringify({ start, forward }),
  );

  const streaming = () =>
    page.evaluate(() => {
      const primitives = window.__godsEyeView.viewer.scene.primitives;
      for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        if (typeof p?.cullRequestsWhileMoving === 'boolean' && p.show)
          return p.cullRequestsWhileMoving;
      }
      return null;
    });
  await page.keyboard.down('ArrowUp');
  const duringFlight = await streaming();
  await page.keyboard.up('ArrowUp');
  const afterFlight = await streaming();
  check(
    'tiles keep streaming during a gesture and settle back after it',
    duringFlight === null || (duringFlight === false && afterFlight === true),
    JSON.stringify({ duringFlight, afterFlight }),
  );

  await hold('KeyE');
  const turned = await pose();
  check(
    'held E turns the heading clockwise',
    ((turned.heading - forward.heading + 540) % 360) - 180 > 1,
    JSON.stringify({ turned }),
  );

  const detection = () =>
    page.evaluate(() =>
      window.__godsEyeView.styleManager.services.getDetectionMode(),
    );
  const layersOpen = () =>
    page.evaluate(() =>
      document.getElementById('data-panel').classList.contains('active'),
    );
  const beforeD = await detection();
  const beforeW = await pose();
  await page.keyboard.press('KeyW');
  await page.keyboard.press('KeyD');
  check(
    'outside fly mode W does not fly and D still cycles Detection',
    !moved(beforeW, await pose()) && (await detection()) !== beforeD,
  );
  await page.keyboard.press('KeyD');
  await page.keyboard.press('KeyD');
  await page.keyboard.press('KeyD');
  // Return Detection to where it started, whatever the cycle length.
  for (let i = 0; i < 8 && (await detection()) !== beforeD; i += 1)
    await page.keyboard.press('KeyD');

  await page.keyboard.press('KeyG');
  check(
    'G turns fly mode on',
    await page.evaluate(
      () =>
        window.__godsEyeView.styleManager._keyboardFlight.isFlyMode() &&
        document.body.classList.contains('keyboard-fly-mode'),
    ),
  );
  const flyStart = await pose();
  const layersBefore = await layersOpen();
  await hold('KeyD');
  await hold('KeyF');
  const flyEnd = await pose();
  await hold('KeyF', 6_000);
  const floor = await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const c = viewer.camera.positionCartographic;
    return { height: c.height, globe: viewer.scene.globe.getHeight(c) };
  });
  check(
    'a long F descent stops above the surface',
    !Number.isFinite(floor.globe) || floor.height >= floor.globe + 5,
    JSON.stringify(floor),
  );
  check(
    'in fly mode D strafes and F descends without reaching their shortcuts',
    moved(flyStart, flyEnd) &&
      flyEnd.height < flyStart.height &&
      (await detection()) === beforeD &&
      (await layersOpen()) === layersBefore,
    JSON.stringify({ flyStart, flyEnd }),
  );
  fs.mkdirSync('qa-shots/keyboard-flight', { recursive: true });
  await page.screenshot({ path: 'qa-shots/keyboard-flight/fly-mode.png' });

  // A clicked toolbar button keeps focus; fly-mode letters must still fly
  // and never fall through to Detection.
  const buttonFocused = await page.evaluate(() => {
    const button =
      document.getElementById('north-up-view') ||
      document.querySelector('button:not([disabled])');
    button.focus();
    return document.activeElement === button && button.tagName === 'BUTTON';
  });
  const buttonStart = await pose();
  await hold('KeyW');
  await hold('KeyD', 400);
  check(
    'with a button focused, fly-mode W flies and D stays off Detection',
    buttonFocused &&
      moved(buttonStart, await pose()) &&
      (await detection()) === beforeD &&
      (await page.evaluate(() =>
        window.__godsEyeView.styleManager._keyboardFlight.isFlyMode(),
      )),
  );

  await page.keyboard.press('Escape');
  check(
    'Escape leaves fly mode',
    await page.evaluate(
      () =>
        !window.__godsEyeView.styleManager._keyboardFlight.isFlyMode() &&
        !document.body.classList.contains('keyboard-fly-mode'),
    ),
  );

  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setStyle('retro');
    manager.setPanelCollapsed('pp-toggles', false, {
      persist: false,
      syncShare: false,
    });
    manager._sliderPanel.classList.remove('collapsed');
    manager._sliderContainer.querySelector('input').focus();
  });
  const sliderStart = await pose();
  await hold('ArrowUp');
  check(
    'a focused slider keeps its arrow keys',
    !moved(sliderStart, await pose()),
  );
  await page.evaluate(() => {
    window.__godsEyeView.styleManager.setStyle('normal');
    document.activeElement?.blur();
  });

  const released = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    const entity = viewer.entities.add({
      position: viewer.camera.pickEllipsoid({
        x: viewer.canvas.clientWidth / 2,
        y: viewer.canvas.clientHeight / 2,
      }),
      point: { pixelSize: 4 },
    });
    viewer.trackedEntity = entity;
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.__qaTrackedEntity = entity;
    return viewer.trackedEntity === entity;
  });
  await hold('ArrowUp');
  check(
    'a keyboard gesture releases the tracked entity',
    released &&
      (await page.evaluate(() => {
        const { viewer } = window.__godsEyeView;
        const ok = viewer.trackedEntity === undefined;
        viewer.entities.remove(window.__qaTrackedEntity);
        return ok;
      })),
  );

  const interrupted = await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    viewer.camera.flyTo({
      destination: viewer.camera.positionWC.clone(),
      orientation: { heading: 1, pitch: -0.6, roll: 0 },
      duration: 20,
    });
    return viewer.scene.screenSpaceCameraController.enableInputs === false;
  });
  const flightStart = await pose();
  await hold('ArrowUp');
  check(
    'a held key interrupts a running camera flight and flies',
    interrupted &&
      moved(flightStart, await pose()) &&
      (await page.evaluate(
        () =>
          window.__godsEyeView.viewer.scene.screenSpaceCameraController
            .enableInputs,
      )),
  );

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
process.exit(failures ? 1 : 0);

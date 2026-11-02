import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToHome } from '../camera.js';
import { DEFAULT_HOME_VIEW } from '../runtimeConfig.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToHome(
    {
      isDestroyed: () => false,
      camera: {
        setView() {},
        flyTo() {
          flights++;
        },
        cancelFlight() {
          cancelled++;
        },
      },
    },
    DEFAULT_HOME_VIEW,
  );
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

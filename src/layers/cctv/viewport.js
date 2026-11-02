import * as Cesium from 'cesium';
import {
  boxInside,
  boxLatSpan,
  boxLonSpan,
  padBox,
  pickViewportEvictions,
} from '../../data/cctvViewportBox.js';
import { cameraIdHueIndex } from './records.js';
import {
  VIEWPORT_DEBOUNCE_MS,
  VIEWPORT_FETCH_LIMIT,
  VIEWPORT_MAX_RECORDS,
  VIEWPORT_MAX_SPAN_DEG,
  VIEWPORT_PAD_FRACTION,
} from './policy.js';

/**
 * Viewport tier: after the camera settles at regional zoom, fetch the cameras
 * inside the view from every loaded source and add the ones the startup
 * catalog does not already hold. The startup catalog is never touched, so
 * everything that walks it (picker, search, next/prev, auto-hop) behaves as
 * before; viewport records are evicted farthest-first once there are more
 * than VIEWPORT_MAX_RECORDS of them.
 */
export function createViewport({ state: layerState, parts, source }) {
  /** The settled view as a degree box, or null when it is too wide or the
   * view does not intersect the globe. */
  function currentViewBox() {
    const viewer = layerState._viewer;
    if (!viewer || viewer.isDestroyed?.()) return null;
    const rect = viewer.camera.computeViewRectangle(
      viewer.scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
    );
    if (!rect) return null;
    const box = {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
    if (
      boxLonSpan(box) > VIEWPORT_MAX_SPAN_DEG ||
      boxLatSpan(box) > VIEWPORT_MAX_SPAN_DEG
    )
      return null;
    return box;
  }

  /** Drop viewport records beyond the cap, never one in view or in use. */
  function evictViewportRecords(box) {
    const protectedIds = new Set(
      [layerState._activeCameraId, layerState._hoverCardId].filter(Boolean),
    );
    const evict = pickViewportEvictions(layerState._records, {
      box,
      max: VIEWPORT_MAX_RECORDS,
      protectedIds,
      distance: (a, b) => parts.model.haversineKm(a.lat, a.lon, b.lat, b.lon),
    });
    for (const record of evict) parts.records.removeRecord(record);
    return evict.length;
  }

  async function refreshViewport() {
    layerState._viewportTimer = 0;
    if (!layerState._enabled || !layerState._viewportSupported) return;
    const box = currentViewBox();
    if (!box) return;
    if (boxInside(box, layerState._viewportFetchedBox)) return;

    const fetchBox = padBox(box, VIEWPORT_PAD_FRACTION);
    layerState._viewportAbort?.abort();
    const abort = new AbortController();
    layerState._viewportAbort = abort;
    let payload;
    try {
      payload = await source.getCatalog({
        bbox: fetchBox,
        limit: VIEWPORT_FETCH_LIMIT,
        signal: abort.signal,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn(
          '[Data:CCTV] viewport camera fetch failed:',
          error?.message || error,
        );
      }
      return;
    }
    // A newer move, a disable or a teardown superseded this request.
    if (abort.signal.aborted || layerState._viewportAbort !== abort) return;
    layerState._viewportAbort = null;
    if (!layerState._enabled || !layerState._billboards) return;

    const fresh = (payload?.sources || []).filter(
      (raw) => !layerState._recordById.has(String(raw?.id || '').trim()),
    );
    const cameras = parts.catalog.buildCatalogFromSources(fresh);
    const added = [];
    for (const camera of cameras) {
      if (layerState._recordById.has(camera.id)) continue;
      parts.records.prepareCamera(camera);
      added.push(
        parts.records.addRecord(camera, {
          groundPrior: null,
          hueIndex: cameraIdHueIndex(camera.id),
          tier: 'viewport',
        }),
      );
    }
    layerState._viewportFetchedBox = fetchBox;
    const evicted = evictViewportRecords(box);
    if (!added.length && !evicted) return;

    if (added.length) {
      // Same ground handling as the startup catalog: the ellipsoidal prior
      // batch applies as it lands, and the staggered queue samples the rest.
      parts.ground
        .resolveGroundPriors(added.map((record) => record.camera))
        .then((priors) => {
          if (priors) parts.ground.applyLateGroundPriors(added, priors);
        })
        .catch(() => {});
      parts.geometryQueue.enqueueGeometryRefresh(added);
    }
    parts.rendering.refreshHorizonCulling();
    parts.rendering.refreshCoverageStyles();
    parts.cards.refreshAmbientCards();
    parts.presentation.notifyListeners();
  }

  /** Debounced: called on every camera moveEnd and on enable. */
  function scheduleViewportRefresh() {
    if (!layerState._enabled || !layerState._viewportSupported) return;
    clearTimeout(layerState._viewportTimer);
    layerState._viewportTimer = setTimeout(() => {
      refreshViewport().catch((error) =>
        console.warn(
          '[Data:CCTV] viewport refresh failed:',
          error?.message || error,
        ),
      );
    }, VIEWPORT_DEBOUNCE_MS);
  }

  /** Stops a pending or in-flight fetch; viewport records already added stay. */
  function cancelViewportRefresh() {
    clearTimeout(layerState._viewportTimer);
    layerState._viewportTimer = 0;
    layerState._viewportAbort?.abort();
    layerState._viewportAbort = null;
  }

  return {
    currentViewBox,
    evictViewportRecords,
    refreshViewport,
    scheduleViewportRefresh,
    cancelViewportRefresh,
  };
}

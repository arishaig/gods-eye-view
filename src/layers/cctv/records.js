import * as Cesium from 'cesium';
import { viewshedColors, cameraHue } from '../../data/cctvViewshed.js';
import {
  CAMERA_ICON,
  IDLE_CAMERA_COLOR,
  CALIBRATION_RANGE_FLOOR_M,
} from './policy.js';

/**
 * Stable non-negative integer from a camera id (FNV-1a), for hues that must
 * not depend on which other cameras happen to be loaded.
 * @param {string} id
 * @returns {number}
 */
export function cameraIdHueIndex(id) {
  let hash = 0x811c9dc5;
  const text = String(id || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Camera record construction and teardown, shared by the startup catalog and
 * the viewport tier so both build exactly the same record and a viewport
 * record can be removed without touching anything another record owns.
 */
export function createRecords({ state: layerState, parts }) {
  /**
   * Restores a saved calibration onto a catalog camera and derives its pose.
   * @param {Object} camera - Catalog camera (mutated).
   */
  function prepareCamera(camera) {
    const savedEntry = layerState._calibrationById.get(camera.id);
    if (savedEntry) {
      // Entries saved before the range floor dropped (no rangeFloorM)
      // keep their effective range by re-basing rangeScale once.
      const values =
        savedEntry.rangeFloorM === CALIBRATION_RANGE_FLOOR_M
          ? savedEntry.values
          : parts.calibration.migrateRangeScaleForFloor(
              savedEntry.values,
              camera.rangeM,
            );
      savedEntry.values = values;
      savedEntry.rangeFloorM = CALIBRATION_RANGE_FLOOR_M;
      camera.calibration = parts.calibration.normalizeCalibration(values);
      camera.calSource = savedEntry.source;
    }
    parts.model.ensureCameraPose(camera);
  }

  /**
   * Builds one record (billboard included) and registers it in the record
   * list and id map.
   * @param {Object} camera - Prepared catalog camera.
   * @param {Object} options
   * @param {?{ellipsoid:number, source:string}} options.groundPrior - Ellipsoidal
   *   ground prior, or null while its batch is still in flight.
   * @param {number} options.hueIndex - Viewshed color identity index.
   * @param {'catalog'|'viewport'} [options.tier] - Which tier owns the record.
   * @returns {Object} The registered record.
   */
  function addRecord(camera, { groundPrior, hueIndex, tier = 'catalog' }) {
    // Cheap first-pass altitude from the ellipsoidal prior (catalog value
    // only as the pre-prior fallback) — the staggered geometry queue
    // refines with sampled tile heights after enable so the init path
    // never raycasts the scene once per camera.
    const priorGround = Number.isFinite(groundPrior?.ellipsoid)
      ? groundPrior.ellipsoid
      : Number(camera.groundElevationM) || 0;
    camera.absoluteHeightM = priorGround + camera.mountHeightM;
    const position = Cesium.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.absoluteHeightM,
    );
    const billboard = layerState._billboards.add({
      id: camera.id,
      image: CAMERA_ICON,
      position,
      color: IDLE_CAMERA_COLOR,
      width: 24,
      height: 24,
      // Field-test fix (2026-07-06): always-on-top. The old finite value
      // (1800 m) re-engaged the depth test at far zoom, where the COARSE
      // far-LOD Google-3D mesh sits above the true ground and swallowed
      // ground-anchored icons ("submerged" pills over SF). Far-side-of-globe
      // icons are handled by refreshHorizonCulling() (the flights-layer
      // EllipsoidalOccluder pattern), not by the depth test.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(350, 1.25, 4_000_000, 0.42),
    });

    const record = {
      camera,
      position,
      billboard,
      coverageEntities: [],
      projection: null,
      // Task 5 (height-datum fix): regime-aware ground resolution state.
      //   groundPrior     — { ellipsoid, source } from the Re:Earth batch
      //     (null until a late batch lands). The prior applies in EVERY
      //     regime and is the terrain-globe resolution outright.
      //   groundResolved  — PER-REGIME one-shot latch (regime key →
      //     boolean): true once this record's resolution completed for that
      //     regime; such records are excluded from the completion pass so
      //     their geometry freezes. Re-armed only on a genuine pose change,
      //     explicit user select/move, or a surface-regime change — never
      //     on the 10s timer.
      //   groundSamples   — PER-REGIME resolved ground (regime key →
      //     metres): the accepted one-shot scene sample in google-3d, the
      //     mirrored prior in terrain-globe. Kept across re-arms as the
      //     "has ever resolved" memory for the B9c mid-stream guard.
      //   frustumPositions — cached Cartesians for pure recomputes (so
      //     plane placement never re-derives geometry it already has).
      groundPrior,
      groundResolved: {},
      groundSamples: {},
      frustumGeometry: null,
      frustumPositions: null,
      // §9.1 activation obstruction probe result: effective-range clamp so
      // the far-cap plane never clips into the tiles. Null = unclamped.
      // Reset + re-probed on every activation; cleared when the user takes
      // the range slider (slider overrides the clamp).
      probeClampRangeM: null,
      // Viewshed (design §3a/§3b): per-camera color identity + the volume
      // primitive handle (exists only in viewshed mode for the visible set).
      viewshedColors: viewshedColors(cameraHue(hueIndex)),
      viewshedPrimitive: null,
      viewshedActiveTint: false,
      // 'catalog' records come from the startup list and live until teardown;
      // 'viewport' records were added for the current view and may be evicted.
      tier,
    };
    layerState._records.push(record);
    layerState._recordById.set(camera.id, record);
    layerState._count = layerState._records.length;
    return record;
  }

  /**
   * Removes one record and everything it owns: billboard, coverage entities,
   * viewshed volume, projection runtime, queued geometry work, card state and
   * its id-map entry. Other records are untouched.
   * @param {Object} record
   */
  function removeRecord(record) {
    if (!record || layerState._recordById.get(record.camera.id) !== record)
      return;
    const id = record.camera.id;
    const viewer = layerState._viewer;
    if (record.coverageEntities?.length) {
      const owned = new Set(record.coverageEntities);
      for (const entity of owned) viewer?.entities.remove(entity);
      layerState._coverageEntities = layerState._coverageEntities.filter(
        (entity) => !owned.has(entity),
      );
      record.coverageEntities = [];
    }
    parts.geometry.destroyViewshedVolume(record);
    if (record.projection) {
      parts.projection.destroyProjectionRuntime(record.projection);
      layerState._projectionEntities = layerState._projectionEntities.filter(
        (runtime) => runtime !== record.projection,
      );
      record.projection = null;
    }
    const queued = layerState._geoQueue.indexOf(record);
    if (queued >= 0) layerState._geoQueue.splice(queued, 1);
    if (record.billboard && layerState._billboards) {
      layerState._billboards.remove(record.billboard);
    }
    record.billboard = null;
    layerState._cardIds.delete(id);
    layerState._cardGraceState.delete(id);
    layerState._cardFrameSlots.delete(id);
    layerState._recordById.delete(id);
    const index = layerState._records.indexOf(record);
    if (index >= 0) layerState._records.splice(index, 1);
    layerState._count = layerState._records.length;
  }

  return { prepareCamera, addRecord, removeRecord };
}

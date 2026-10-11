import * as Cesium from 'cesium';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import { GROUND_PRIOR_INIT_WAIT_MS } from './policy.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { registerSpriteCollection, restoreSpriteOrder } = services.sprites;
  const { activateCctvCameraFromWorldClick } = services.activation;
  const { resolvePickId, registerPickOwner, unregisterPickOwner } =
    services.picking;
  const { onFocusTargetAppear } = services.focus;
  const { releaseContinuousRender } = services.render;

  /** Resets all module-scoped runtime state to initial values. */

  function clearRuntimeState() {
    parts.geometryQueue.stopGeometryLoadQueue();
    // The record set the fetched box described is gone with it.
    parts.viewport.cancelViewportRefresh();
    layerState._viewportFetchedBox = null;
    // Idempotent — also covers a re-init without a prior destroy().
    parts.cards.teardownAmbientCards();
    parts.projection.clearProjectionOverlay();
    layerState._records = [];
    layerState._recordById = new Map();
    layerState._healthById = new Map();
    layerState._count = 0;
    layerState._lastUpdate = null;
    layerState._lastHealthSyncAt = 0;
    layerState._lastError = null;
    layerState._lastFocusStyleAt = 0;
    layerState._activeFocusStyleCount = 0;
    // FIX ①/③: the discovered tileset handle is scene-scoped — drop it so a fresh
    // init re-discovers against the current scene primitives.
    layerState._activeTileset = null;
    // Task 5: the applied-regime tracker is record-set-scoped — a fresh init
    // recomputes it against the then-current scene.
    layerState._lastAppliedRegime = null;
  }
  const methods = {
    /**
     * Initializes the CCTV layer: loads camera sources, builds the catalog,
     * restores calibration from localStorage, creates billboards, sets up click
     * handling, and performs initial health sync. Coverage entities stay lazy.
     * @param {Cesium.Viewer} viewer - The Cesium viewer instance.
     */
    async init(viewer) {
      layerState._sourceAbort?.abort();
      const sourceAbort = new AbortController();
      layerState._sourceAbort = sourceAbort;
      if (typeof document !== 'undefined')
        document.addEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      layerState._viewer = viewer;
      clearRuntimeState();
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      layerState._lastHopAt = 0;
      layerState._lastViewContext = '';
      layerState._calibrationById = parts.calibration.loadCalibrationStore();

      layerState._billboards = new Cesium.BillboardCollection();
      layerState._viewer.scene.primitives.add(layerState._billboards);
      registerSpriteCollection('cctv', layerState._billboards);

      const sources = await parts.catalog.loadCameraSources();
      const catalogFromSources = parts.catalog.buildCatalogFromSources(sources);
      const catalog = catalogFromSources.length
        ? catalogFromSources
        : parts.catalog.seedCatalog();

      // Viewshed color identity (design §3a): golden-angle hue over the
      // id-SORTED catalog index — deterministic across sessions for a stable
      // catalog, maximally separated for neighboring cameras.
      const hueIndexById = new Map(
        catalog
          .map((camera) => camera.id)
          .sort()
          .map((id, index) => [id, index]),
      );

      for (const camera of catalog) parts.records.prepareCamera(camera);

      // Task 5 (height-datum fix): batch ALL camera coords through the Re:Earth
      // ellipsoidal ground-prior resolver (network-cached — NOT a scene query;
      // the catalog's orthometric groundElevationM feeds the geoid fallback
      // chain). Bounded wait: a warm proxy cache resolves in milliseconds, so
      // records are normally built WITH their prior (correct first paint in
      // every regime); a cold/slow upstream loses the race and the batch
      // applies post-hoc via applyLateGroundPriors instead of hanging init.
      const priorsPromise = parts.ground.resolveGroundPriors(catalog);
      const priors = await Promise.race([
        priorsPromise,
        new Promise((resolve) =>
          setTimeout(() => resolve(null), GROUND_PRIOR_INIT_WAIT_MS),
        ),
      ]);
      sourceAbort.signal.throwIfAborted();

      for (let i = 0; i < catalog.length; i++) {
        // Ellipsoidal ground prior (or null while the batch is still in
        // flight). Geometry falls back to the catalog value only until the
        // batch lands.
        parts.records.addRecord(catalog[i], {
          groundPrior: priors?.[i] || null,
          hueIndex: hueIndexById.get(catalog[i].id) ?? 0,
        });
      }

      layerState._count = layerState._records.length;
      if (layerState._records.length > 0) {
        // Projection runtime + first frame fetch are deferred to enable() so
        // initializing the catalog stays render-cheap.
        layerState._activeCameraId = layerState._records[0].camera.id;
      }

      // Task 5: if the prior batch lost init's bounded race, apply it post-hoc
      // when it lands (pure recomputes — applyLateGroundPriors guards against
      // a torn-down/re-inited catalog).
      if (!priors) {
        const initRecords = layerState._records.slice();
        priorsPromise
          .then((late) => {
            if (late) parts.ground.applyLateGroundPriors(initRecords, late);
          })
          .catch(() => {});
      }

      // Task 5: track the surface regime the initial geometry was computed for
      // and listen for map-stack changes (main.js re-dispatches
      // MapStackController.onChange as this CustomEvent). The handler compares
      // regimes itself, so 'switching'/'error' emissions and same-regime stack
      // swaps (bing→osm) no-op.
      layerState._lastAppliedRegime = parts.ground.currentSurfaceRegime();
      if (!layerState._mapStackListener && typeof window !== 'undefined') {
        layerState._mapStackListener = () =>
          parts.ground.handleMapStackChanged();
        window.addEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
      }

      // Field-test fix (2026-07-06): horizon-cull on camera settle (pairs with
      // the billboards' always-on-top depth setting) + one initial pass so the
      // first paint is already culled.
      if (!layerState._horizonCullListener) {
        // Ambient cards piggyback the same settle event: moveEnd-driven
        // reselection only, never per frame (refreshAmbientCards no-ops while
        // the layer is disabled).
        layerState._horizonCullListener = () => {
          layerState._cameraMoving = false;
          parts.rendering.refreshHorizonCulling();
          parts.cards.refreshAmbientCards();
        };
        layerState._viewer.camera.moveEnd.addEventListener(
          layerState._horizonCullListener,
        );
      }
      if (!layerState._viewportMoveEndListener) {
        // Viewport tier: debounced fetch of the cameras in the settled view
        // (no-ops while disabled, at wide zoom, or against an older server).
        layerState._viewportMoveEndListener = () =>
          parts.viewport.scheduleViewportRefresh();
        layerState._viewer.camera.moveEnd.addEventListener(
          layerState._viewportMoveEndListener,
        );
      }
      if (!layerState._moveStartListener) {
        // Item B: hover picking pauses while the camera is in motion.
        layerState._moveStartListener = () => {
          layerState._cameraMoving = true;
        };
        layerState._viewer.camera.moveStart.addEventListener(
          layerState._moveStartListener,
        );
      }
      parts.rendering.refreshHorizonCulling();

      layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
        layerState._viewer.scene.canvas,
      );
      parts.selection.bindCctvWorldClickGesture(
        layerState._clickHandler,
        (click) => {
          if (!layerState._enabled) return;
          const picked = layerState._viewer.scene.pick(click.position);
          const cameraId = parts.selection.extractPickedCameraId(picked);
          if (cameraId) {
            activateCctvCameraFromWorldClick(
              cameraId,
              parts.selection.setActiveCamera,
            );
            return;
          }
          // Any identified scene object owns this click even if its layer does not
          // register a shared pick predicate. This keeps selectable siblings ahead
          // of an overlapping CCTV card while ID-less globe/terrain/tile surfaces
          // remain eligible for true empty-space deselection.
          const pickedId = resolvePickId(picked);
          if (pickedId !== null) return;
          // Item A (owner round 2): the scene pick found no camera — try the
          // painted ambient cards. The cards canvas is pointer-events:none (this
          // handler owns the events), so a click landing on a card's rect selects
          // its camera exactly like a click on the icon. Cesium click positions
          // and the recorded rects are both CSS px — direct comparison.
          const cardId = layerState._cctvOverlayHost.hitTest(
            click.position.x,
            click.position.y,
            { sourceId: CCTV_OVERLAY_SOURCE_ID },
          )?.entryId;
          if (cardId && layerState._recordById.has(cardId)) {
            activateCctvCameraFromWorldClick(
              cardId,
              parts.selection.setActiveCamera,
            );
            return;
          }
          if (
            parts.selection.cctvEmptyClickDeselects(picked, {
              activeCameraId: layerState._activeCameraId,
              calibrationMode: layerState._calibrationMode,
            })
          ) {
            parts.selection.deactivateActiveCamera();
          }
        },
        {
          // Item B: hover summons a card on a cardless camera icon. The gesture
          // classifier owns MOUSE_MOVE too, so chain hover work through its seam
          // instead of replacing the travel accumulator's handler.
          onMouseMove: (movement) =>
            parts.hover.handleHoverMove(movement?.endPosition),
        },
      );

      await parts.health.syncHealthState(true);
      parts.rendering.refreshCoverageStyles();
      parts.presentation.notifyListeners();
      restoreSpriteOrder(layerState._viewer);
      console.log('[Data:CCTV] Initialized with', layerState._count, 'cameras');
    },

    /**
     * Enables the layer: shows entities, starts the projection loop, and kicks
     * the staggered geometry-load queue. Heavy work (per-camera ground
     * sampling) is deferred/batched so the frame budget never collapses at
     * enable time.
     */
    enable() {
      layerState._enabled = true;
      if (
        layerState._records.some(
          (record) => record.camera.cityId === 'warendorf',
        )
      )
        services.credits?.showOsmCredit?.(layerState._viewer, 'cctv');
      layerState._lastUpdate = Date.now();
      // Pick-ownership (H2): camera billboards use the camera id directly;
      // coverage polyline entities use `cctv-<cameraId>-<role>` entity ids.
      registerPickOwner('cctv', (pickedId) => {
        if (layerState._recordById.has(pickedId)) return true;
        if (
          typeof pickedId === 'string' &&
          pickedId.startsWith(GIZMO_ID_PREFIX)
        )
          return true;
        const coverage =
          /^cctv-(.+)-(?:ray-tl|ray-tr|ray-br|ray-bl|cap|plane|plane-label)$/.exec(
            pickedId,
          );
        return Boolean(coverage && layerState._recordById.has(coverage[1]));
      });
      if (!layerState._activeCameraId && layerState._records.length) {
        layerState._activeCameraId = layerState._records[0].camera.id;
        layerState._autoHopSuspended = false;
      }
      const activeRecord = parts.selection.getActiveRecord();
      if (activeRecord) {
        parts.projection.ensureProjectionRuntime(activeRecord);
        parts.frames.refreshProjectionImage(activeRecord, true);
      }
      parts.geometryQueue.startGeometryLoadQueue();
      parts.rendering.refreshCoverageStyles();
      parts.projection.startProjectionLoop();
      // The projection loop self-stops when idle; a focus target appearing
      // (user starts tracking a contact) is the one edge it can't see while
      // stopped, so re-arm on it. Removed on disable.
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = onFocusTargetAppear(() =>
        parts.projection.startProjectionLoop(),
      );
      // Ambient card tier: shared host source + policy-gated frame pacer + the
      // initial selection pass (moveEnd drives every later reselection).
      layerState._cctvOverlayHost.setVisible(CCTV_OVERLAY_SOURCE_ID, true);
      parts.cards.startCardFrameLoop();
      parts.cards.refreshAmbientCards();
      parts.viewport.scheduleViewportRefresh();
      parts.presentation.notifyListeners();
      restoreSpriteOrder(layerState._viewer);
    },

    /** Disables the layer: hides entities, stops the projection loop and load queue. */
    disable() {
      services.credits?.hideOsmCredit?.(layerState._viewer, 'cctv');
      layerState._enabled = false;
      unregisterPickOwner('cctv');
      // ADJUST mode does not survive a layer toggle — predictable re-entry.
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      layerState._gizmo?.setEnabled(false);
      layerState._removeFocusAppearListener?.();
      layerState._removeFocusAppearListener = null;
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      parts.viewport.cancelViewportRefresh();
      // Ambient cards tear down COMPLETELY on disable (owner design point 6):
      // source entries, pacer timer, in-flight handlers, and caches.
      parts.cards.teardownAmbientCards();
      parts.rendering.hideCctvVisuals();
      parts.presentation.notifyListeners();
    },

    /**
     * Tears down the layer: destroys click handler, projection loop, coverage
     * entities, billboards, and clears all runtime state and subscribers.
     * @param {Cesium.Viewer} [viewer] - Viewer instance (falls back to stored ref).
     */
    destroy(viewer) {
      services.credits?.hideOsmCredit?.(layerState._viewer, 'cctv');
      layerState._sourceAbort?.abort();
      if (typeof document !== 'undefined')
        document.removeEventListener(
          'visibilitychange',
          parts.cards.handleVisibilityChange,
        );
      unregisterPickOwner('cctv');
      if (layerState._mapStackListener && typeof window !== 'undefined') {
        window.removeEventListener(
          'gev:map-stack-changed',
          layerState._mapStackListener,
        );
        layerState._mapStackListener = null;
      }
      const teardownViewer = viewer || layerState._viewer;
      if (layerState._horizonCullListener && teardownViewer?.camera?.moveEnd) {
        teardownViewer.camera.moveEnd.removeEventListener(
          layerState._horizonCullListener,
        );
        layerState._horizonCullListener = null;
      }
      if (
        layerState._viewportMoveEndListener &&
        teardownViewer?.camera?.moveEnd
      ) {
        teardownViewer.camera.moveEnd.removeEventListener(
          layerState._viewportMoveEndListener,
        );
        layerState._viewportMoveEndListener = null;
      }
      if (layerState._moveStartListener && teardownViewer?.camera?.moveStart) {
        teardownViewer.camera.moveStart.removeEventListener(
          layerState._moveStartListener,
        );
        layerState._moveStartListener = null;
      }
      if (layerState._gizmo) {
        layerState._gizmo.destroy();
        layerState._gizmo = null;
      }
      layerState._calibrationMode = false;
      releaseContinuousRender('cctv-adjust');
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (teardownViewer?.scene?.screenSpaceCameraController) {
        teardownViewer.scene.screenSpaceCameraController.enableInputs = true;
      }
      parts.projection.stopProjectionLoop();
      parts.geometryQueue.stopGeometryLoadQueue();
      parts.cards.teardownAmbientCards();
      parts.geometry.destroyCoverageEntities();
      if (layerState._billboards && teardownViewer) {
        teardownViewer.scene.primitives.remove(layerState._billboards);
        layerState._billboards = null;
      }
      clearRuntimeState();
      layerState._viewer = null;
      layerState._enabled = false;
      layerState._activeCameraId = null;
      layerState._autoHopSuspended = false;
      // Clear existing subscribers rather than replacing the Set —
      // replacing would silently orphan any unsubscribe() closures
      layerState._listeners.clear();
    },
  };

  return { clearRuntimeState, methods };
}

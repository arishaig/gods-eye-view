import * as Cesium from 'cesium';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import {
  GROUND_PRIOR_INIT_WAIT_MS,
  VIEW_MOTION_REFRESH_MS,
  VIEW_MOTION_MIN_MOVE_FRACTION,
  VIEW_MOTION_MIN_TURN_DEG,
  VIEW_MOTION_COST_FACTOR,
} from './policy.js';

const MIN_TURN_COS = Math.cos((VIEW_MOTION_MIN_TURN_DEG * Math.PI) / 180);

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

  /**
   * The settled-view pass: thin the icons, queue the newly visible geometry,
   * reselect cards, and tell subscribers (the camera picker) when the shown
   * set changed since they were last told, including by motion passes.
   */
  function settleView() {
    const changed = parts.rendering.refreshHorizonCulling();
    noteViewPose();
    parts.geometryQueue.enqueueViewGeometry();
    parts.cards.refreshAmbientCards();
    if (changed || layerState._viewUnpublished) {
      layerState._viewUnpublished = false;
      parts.presentation.notifyListeners();
    }
  }

  /** Records the camera pose the last view pass ran at. */
  function noteViewPose() {
    const camera = layerState._viewer?.camera;
    if (!camera?.positionWC) return;
    layerState._viewPose = {
      position: Cesium.Cartesian3.clone(camera.positionWC),
      direction:
        camera.directionWC && Cesium.Cartesian3.clone(camera.directionWC),
    };
  }

  /**
   * Whether the camera moved or turned enough since the last view pass to
   * change what is on screen. A camera that tracks or flies without settling
   * would otherwise rerun the full pass on every tick.
   */
  function viewPoseChanged() {
    const camera = layerState._viewer?.camera;
    const pose = layerState._viewPose;
    if (!pose || !camera?.positionWC) return true;
    const height = Math.max(1, camera.positionCartographic?.height ?? 0);
    const moved = Cesium.Cartesian3.distance(camera.positionWC, pose.position);
    if (moved > height * VIEW_MOTION_MIN_MOVE_FRACTION) return true;
    if (!pose.direction || !camera.directionWC) return false;
    return (
      Cesium.Cartesian3.dot(camera.directionWC, pose.direction) < MIN_TURN_COS
    );
  }

  function viewMotionTick() {
    if (!layerState._enabled) return;
    const now = performance.now();
    const pass = layerState._viewMotionPass;
    if (pass && now - pass.at < pass.ms * VIEW_MOTION_COST_FACTOR) return;
    if (!viewPoseChanged()) return;
    if (parts.rendering.refreshHorizonCulling())
      layerState._viewUnpublished = true;
    noteViewPose();
    parts.geometryQueue.enqueueViewGeometry();
    layerState._viewMotionPass = { at: now, ms: performance.now() - now };
  }

  function startViewMotionTimer() {
    if (layerState._viewMotionTimer) return;
    layerState._viewMotionTimer = setInterval(
      viewMotionTick,
      VIEW_MOTION_REFRESH_MS,
    );
  }

  function stopViewMotionTimer() {
    clearInterval(layerState._viewMotionTimer);
    layerState._viewMotionTimer = 0;
  }

  /** Resets all module-scoped runtime state to initial values. */

  function clearRuntimeState() {
    parts.geometryQueue.stopGeometryLoadQueue();
    stopViewMotionTimer();
    // The record set the fetched box described is gone with it.
    parts.viewport.cancelViewportRefresh();
    layerState._viewportFetchedBox = null;
    // Idempotent — also covers a re-init without a prior destroy().
    parts.cards.teardownAmbientCards();
    parts.projection.clearProjectionOverlay();
    layerState._records = [];
    layerState._recordById = new Map();
    layerState._viewRecords = [];
    layerState._cameraIndexCache = null;
    layerState._coverageVisibleIds = new Set();
    layerState._neighborCountCache = null;
    layerState._viewUnpublished = false;
    layerState._viewPose = null;
    layerState._viewMotionPass = null;
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
      // Cesium switches a property's buffer-usage hint whenever it starts or
      // stops changing from one frame to the next, and every switch rewrites
      // the vertex data of every billboard. The view pass toggles `show` on a
      // few icons of a large catalog at a time, so on a 33K catalog each pass
      // cost two full rewrites. With the hint fixed, Cesium uploads only the
      // icons that changed.
      layerState._billboards.computeNewBuffersUsage = () => false;
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
      // A re-init against a new viewer moves the move listeners to its camera.
      if (
        layerState._viewListenerCamera &&
        layerState._viewListenerCamera !== layerState._viewer.camera
      ) {
        const previous = layerState._viewListenerCamera;
        if (layerState._horizonCullListener)
          previous.moveEnd?.removeEventListener(
            layerState._horizonCullListener,
          );
        if (layerState._moveStartListener)
          previous.moveStart?.removeEventListener(
            layerState._moveStartListener,
          );
        layerState._horizonCullListener = null;
        layerState._moveStartListener = null;
        layerState._cameraMoving = false;
      }
      layerState._viewListenerCamera = layerState._viewer.camera;
      if (!layerState._horizonCullListener) {
        // Ambient cards piggyback the same settle event: moveEnd-driven
        // reselection only, never per frame (refreshAmbientCards no-ops while
        // the layer is disabled).
        layerState._horizonCullListener = () => {
          layerState._cameraMoving = false;
          stopViewMotionTimer();
          settleView();
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
        // Item B: hover picking pauses while the camera is in motion. A long
        // move (cockpit flight, a drag) never settles, so the view pass also
        // reruns on an interval until it does.
        layerState._moveStartListener = () => {
          layerState._cameraMoving = true;
          // enable() starts it for a move already under way.
          if (layerState._enabled) startViewMotionTimer();
        };
        layerState._viewer.camera.moveStart.addEventListener(
          layerState._moveStartListener,
        );
      }
      // A resize or rotation changes what is on screen without moving the
      // camera.
      const canvas = layerState._viewer.scene?.canvas;
      if (layerState._viewResizeCanvas !== canvas) {
        // A re-init against a new viewer observes its canvas instead.
        layerState._viewResizeObserver?.disconnect();
        layerState._viewResizeObserver = null;
        layerState._viewResizeCanvas = null;
      }
      if (
        !layerState._viewResizeObserver &&
        typeof ResizeObserver === 'function' &&
        canvas
      ) {
        let frame = 0;
        layerState._viewResizeObserver = new ResizeObserver(() => {
          if (frame || !layerState._enabled) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (layerState._enabled) settleView();
          });
        });
        layerState._viewResizeObserver.observe(canvas);
        layerState._viewResizeCanvas = canvas;
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
      // Health ranks crowded cells: thin again now that it has arrived (a
      // no-op unless enable() ran while health was loading).
      if (parts.rendering.refreshHorizonCulling()) {
        parts.geometryQueue.enqueueViewGeometry();
        parts.cards.refreshAmbientCards();
      }
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
      parts.rendering.refreshHorizonCulling();
      // Re-enabled mid-flight: moveStart has already fired.
      if (layerState._cameraMoving) startViewMotionTimer();
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
      stopViewMotionTimer();
      parts.viewport.cancelViewportRefresh();
      // Ambient cards tear down COMPLETELY on disable (owner design point 6):
      // source entries, pacer timer, in-flight handlers, and caches.
      parts.cards.teardownAmbientCards();
      parts.rendering.hideCctvVisuals();
      // Nothing is in view while the layer is off.
      layerState._viewRecords = [];
      layerState._cameraIndexCache = null;
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
      // The move listeners are gone; nothing will report the end of a move.
      layerState._cameraMoving = false;
      layerState._viewListenerCamera = null;
      stopViewMotionTimer();
      layerState._viewResizeObserver?.disconnect();
      layerState._viewResizeObserver = null;
      layerState._viewResizeCanvas = null;
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

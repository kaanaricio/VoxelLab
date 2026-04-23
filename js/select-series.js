import { $ } from './dom.js';
import { state } from './state.js';
import { stopCine } from './cine.js';
import { applySelectSeriesDom } from './select-series-dom.js';
import { loadImageStack, regionMetaUrlForSeries } from './series-image-stack.js';
import { cachedFetchJson } from './cached-fetch.js';
import { tryFlattenVoxelsInWorker } from './volume-voxels-ensure.js';
import { ensureHRVoxels } from './volume-hr-voxels.js';
import { getPreferredOverlays } from './overlay-preferences.js';
import { beginPerfTrace } from './perf-trace.js';
import { applyCrossOriginPreloads } from './preload-cross-origin.js';
import { PERF_MODE } from './runtime-flags.js';
import { activeOverlayStateForSeries } from './runtime/active-overlay-state.js';
import { beginViewerRuntimeSession, syncViewerRuntimeSession } from './runtime/viewer-session.js';
import {
  buildCompareGrid,
  loadComparePeers,
  drawCompare,
} from './compare.js';
import { drawSparkline } from './sparkline.js';
import { renderAnnotationList } from './annotation.js';
import { updateOrientationMarkers } from './viewport.js';
import { markViewAwaitingSliceFade } from './slice-view.js';
import { renderVolumeTable } from './metadata.js';
import { updateInfoTips } from './info-tips.js';
import { hydrateDerivedStateForSeries } from './dicom-derived-import.js';
import { notifyProjectsChanged } from './projects.js';
import { hardFail, softFail } from './error.js';
import { syncOverlays, syncZScrubberSlider } from './sync.js';
import {
  beginSeriesSelection,
  finishSeriesSelection,
  hydrateSeriesSidecars,
  hydrateSeriesStacks,
  initializeSeriesViewState,
  isSeriesSelectionCurrent,
} from './state/viewer-commands.js';
import { syncAskModeAfterViewChange } from './consult-ask.js';
import { setSpinnerPending } from './spinner.js';
import {
  BASE_PREFETCH_CONCURRENCY,
  OVERLAY_PREFETCH_CONCURRENCY,
  REMOTE_BASE_PREFETCH_CONCURRENCY,
  REMOTE_OVERLAY_PREFETCH_CONCURRENCY,
} from './constants.js';

const REMOTE_BASE_PREFETCH_LIMIT = PERF_MODE ? 0 : Infinity;
const REMOTE_OVERLAY_PREFETCH_LIMIT = PERF_MODE ? 0 : Infinity;

export async function selectSeries(i, v, { preserveSlice = false } = {}) {
  const series = state.manifest.series[i];
  beginPerfTrace('select-series-2d', { slug: series?.slug || '', seriesIdx: i });
  const isRemote = !!series?.sliceUrlBase;
  const basePrefetchConcurrency = isRemote ? REMOTE_BASE_PREFETCH_CONCURRENCY : BASE_PREFETCH_CONCURRENCY;
  const overlayPrefetchConcurrency = isRemote ? REMOTE_OVERLAY_PREFETCH_CONCURRENCY : OVERLAY_PREFETCH_CONCURRENCY;
  const selection = beginSeriesSelection(i, { preserveSlice });
  markViewAwaitingSliceFade();
  const requestId = selection.requestId;
  v.resetTransform();
  stopCine();

  if (isRemote) setSpinnerPending('series-load', true);
  const scrubEl = $('scrub');
  const zScrubEl = $('s-zscrub');
  if (scrubEl && isRemote) scrubEl.disabled = true;
  if (zScrubEl && isRemote) zScrubEl.disabled = true;

  const isCurrent = () => isSeriesSelectionCurrent(requestId, series.slug);
  const refreshSidebarData = () => {
    v.renderFindings();
    v.renderScrubTicks();
    v.renderRegionLegend();
    v.renderFusionPicker();
    renderAnnotationList();
    renderVolumeTable();
    v.syncModalityPresets();
    v.syncOverlayOpacityUI();
    v.syncToolbarReadyState();
    updateInfoTips(series);
  };
  await notifyProjectsChanged(i);
  beginViewerRuntimeSession(series, { seriesIdx: i, requestId });
  initializeSeriesViewState(series);
  hydrateDerivedStateForSeries(series);
  const overlays = activeOverlayStateForSeries(series);
  applyCrossOriginPreloads(state.manifest, { activeSeriesIdx: i });
  applySelectSeriesDom(i, series, v);
  updateOrientationMarkers(series);

  const variant = state.useBrain && series.hasBrain ? `${series.slug}_brain` : series.slug;
  const windowRadius = isRemote ? (PERF_MODE ? 0 : 1) : 5;
  const currentIndex = state.sliceIdx;

  const base = loadImageStack(variant, series.slices, state.imgs, series, {
    label: `${series.slug} base stack`,
    errorMode: 'hard',
    windowRadius,
    initialIndex: currentIndex,
  });
  hydrateSeriesStacks({ imgs: base.imgs });
  syncViewerRuntimeSession(series);
  const baseLoaders = base.loaders;

  const overlayLoaders = [];
  if (overlays.tissue.enabled) {
    const seg = loadImageStack(`${series.slug}_seg`, series.slices, state.segImgs, series, {
      label: `${series.slug} tissue overlay`,
      errorMode: 'hard',
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ segImgs: seg.imgs });
    overlayLoaders.push(...seg.loaders);
  }
  if (overlays.heatmap.enabled) {
    const sym = loadImageStack(`${series.slug}_sym`, series.slices, state.symImgs, series, {
      label: `${series.slug} symmetry overlay`,
      errorMode: 'hard',
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ symImgs: sym.imgs });
    overlayLoaders.push(...sym.loaders);
  }
  if (overlays.labels.enabled) {
    const reg = loadImageStack(`${series.slug}_regions`, series.slices, state.regionImgs, series, {
      label: `${series.slug} anatomy overlay`,
      errorMode: 'hard',
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ regionImgs: reg.imgs });
    overlayLoaders.push(...reg.loaders);
  }

  // Prefetch preferred overlays for this modality when toggles are off so the
  // first enable renders immediately.
  const preferredOverlays = new Set(getPreferredOverlays(series.modality));
  if (preferredOverlays.has('seg') && overlays.tissue.available && !overlays.tissue.enabled) {
    const seg = loadImageStack(`${series.slug}_seg`, series.slices, state.segImgs, series, {
      label: `${series.slug} tissue overlay (preferred)`,
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ segImgs: seg.imgs });
    overlayLoaders.push(...seg.loaders);
  }
  if (preferredOverlays.has('sym') && overlays.heatmap.available && !overlays.heatmap.enabled) {
    const sym = loadImageStack(`${series.slug}_sym`, series.slices, state.symImgs, series, {
      label: `${series.slug} symmetry overlay (preferred)`,
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ symImgs: sym.imgs });
    overlayLoaders.push(...sym.loaders);
  }
  if (preferredOverlays.has('regions') && overlays.labels.available && !overlays.labels.enabled) {
    const reg = loadImageStack(`${series.slug}_regions`, series.slices, state.regionImgs, series, {
      label: `${series.slug} anatomy overlay (preferred)`,
      windowRadius,
      initialIndex: currentIndex,
    });
    hydrateSeriesStacks({ regionImgs: reg.imgs });
    overlayLoaders.push(...reg.loaders);
  }

  const regionMetaPromise = overlays.labels.available
    ? Promise.resolve(state._localRegionMetaBySlug[series.slug] || null)
      .then((localMeta) => localMeta || hardFail(
        cachedFetchJson(regionMetaUrlForSeries(series)),
        `${series.slug} anatomy metadata`,
      ))
    : Promise.resolve(null);
  const askHistoryPromise = series.hasContext
    ? softFail(
      cachedFetchJson(`./data/${series.slug}_asks.json`).then((d) => d?.entries || null),
      `${series.slug} ask history`,
    )
    : Promise.resolve(null);
  const statsPromise = series.hasStats
    ? softFail(cachedFetchJson(`./data/${series.slug}_stats.json`), `${series.slug} stats`)
    : Promise.resolve(null);

  // Analysis JSON loads in parallel with base loaders; applied in the sidecar batch below.
  const analysisPromise = series.hasAnalysis
    ? softFail(cachedFetchJson(`./data/${series.slug}_analysis.json`), `${series.slug} analysis`)
    : Promise.resolve(null);
  if (!isCurrent()) return;
  refreshSidebarData();
  drawSparkline();

  $('volumes-panel').hidden = true;

  if (series.hasRaw || series.rawUrl) {
    ensureHRVoxels().then(() => {
      if (!isCurrent()) return;
      syncViewerRuntimeSession(series);
    });
  }

  if (baseLoaders.length > 0) await baseLoaders[0];
  if (!isCurrent()) return;
  setSpinnerPending('series-load', false);
  if (scrubEl) scrubEl.disabled = false;
  syncViewerRuntimeSession(series);
  syncZScrubberSlider(series);
  finishSeriesSelection();
  if (isCurrent() && state.mode === '2d') {
    requestAnimationFrame(() => v.zoomToFit());
  }
  // Analysis applies via hydrateSeriesSidecars with the other sidecars.
  const [regionMeta, askHistory, stats, analysis] = await Promise.all([
    regionMetaPromise,
    askHistoryPromise,
    statsPromise,
    analysisPromise,
  ]);
  if (!isCurrent()) return;
  hydrateSeriesSidecars({ regionMeta, askHistory, stats, analysis });
  applySelectSeriesDom(i, series, v);
  syncViewerRuntimeSession(series);
  refreshSidebarData();
  syncViewerRuntimeSession(series);
  syncAskModeAfterViewChange();
  Promise.all([
    state.segImgs.ensureIndex?.(currentIndex) || Promise.resolve(true),
    state.symImgs.ensureIndex?.(currentIndex) || Promise.resolve(true),
    state.regionImgs.ensureIndex?.(currentIndex) || Promise.resolve(true),
  ]).then(() => {
    if (!isCurrent() || state.sliceIdx !== currentIndex) return;
    syncOverlays();
  });

  if (state.mode === 'cmp') {
    buildCompareGrid();
    await loadComparePeers();
    if (!isCurrent()) return;
    drawCompare();
  }

  // Shape: { variant: "full" } when the whole base stack is warm enough for MPR/3D reuse.
  const triggerRebuildAfterBaseReady = async (variant) => {
    if (!isCurrent()) return;
    const voxelsKeyBefore = state.voxelsKey;
    await tryFlattenVoxelsInWorker();
    if (!isCurrent()) return;
    syncViewerRuntimeSession(series);
    if (variant === 'full' && state.voxelsKey === voxelsKeyBefore && voxelsKeyBefore) return;
    if (v.is3dActive()) {
      v.applyThreeDPresetForSeries(series.slug);
      v.buildVolume();
      v.updateUniforms();
      v.updateClipReadouts();
    }
    if (v.isMprActive()) { v.ensureVoxels(); v.drawMPR(); }
    if (overlays.tissue.available && state.mode !== '3d' && state.mode !== 'mpr') v.ensureVoxels();
  };

  Promise.all(baseLoaders).then(() => triggerRebuildAfterBaseReady('window'));

  if (!isRemote || !PERF_MODE) {
    const fullBaseLoad = base.imgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
      concurrency: basePrefetchConcurrency,
      limit: isRemote ? REMOTE_BASE_PREFETCH_LIMIT : Infinity,
    }) || Promise.resolve([]);
    const fullOverlayLoad = Promise.all([
      state.segImgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: overlayPrefetchConcurrency,
        limit: isRemote ? REMOTE_OVERLAY_PREFETCH_LIMIT : Infinity,
      }) || Promise.resolve([]),
      state.symImgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: overlayPrefetchConcurrency,
        limit: isRemote ? REMOTE_OVERLAY_PREFETCH_LIMIT : Infinity,
      }) || Promise.resolve([]),
      state.regionImgs.prefetchRemaining?.(state.sliceIdx, windowRadius, {
        concurrency: overlayPrefetchConcurrency,
        limit: isRemote ? REMOTE_OVERLAY_PREFETCH_LIMIT : Infinity,
      }) || Promise.resolve([]),
    ]);
    Promise.resolve(fullBaseLoad).then(() => triggerRebuildAfterBaseReady('full'));
    void fullOverlayLoad;
  }
}

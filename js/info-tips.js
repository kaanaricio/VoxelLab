/**
 * info-tips.js — Dynamic methodology tooltips for medical transparency.
 *
 * Exports updateInfoTips(series) — invoked from js/select-series.js on series change.
 * in viewer.js after the active series changes. It updates the data-info
 * attributes on tooltip elements whose content depends on the series
 * (e.g., anatomy source = SynthSeg vs TotalSegmentator).
 *
 * Integration (one-time, in viewer.js):
 *   import { updateInfoTips } from './js/info-tips.js';
 *   // inside selectSeries(), after `const s = manifest.series[i];`:
 *   updateInfoTips(s);
 */

const ANATOMY_TIPS = {
  synthseg:
    'Anatomical parcellation via SynthSeg (Billot et al., Medical Image Analysis 2023). ' +
    '32 brain regions segmented using a contrast-agnostic deep learning model. ' +
    'Not for clinical diagnosis.',
  totalseg:
    'Organ segmentation via TotalSegmentator v2 (Wasserthal et al., Radiology: AI 2023). ' +
    '67 anatomical structures identified using nnU-Net. ' +
    'Not for clinical diagnosis.',
  default:
    'Anatomical region overlay. Source depends on series modality. ' +
    'Not for clinical diagnosis.',
};

const VOLUME_LINE = {
  synthseg: 'Volumes computed from voxel counts \u00d7 pixel spacing \u00d7 slice thickness. Model: SynthSeg.',
  totalseg: 'Volumes computed from voxel counts \u00d7 pixel spacing \u00d7 slice thickness. Model: TotalSegmentator.',
  default:  'Volumes computed from voxel counts \u00d7 pixel spacing \u00d7 slice thickness.',
};

/**
 * Update all dynamic info-tip tooltips for the given series object.
 * @param {Object} series — the current series entry from manifest.json
 */
/**
 * Pins .info-tip--viewport tooltips with position:fixed via CSS variables so they are not
 * clipped by .right-panel-scroll overflow (absolute ::after stays inside the scroll box).
 */
export function wirePanelInfoViewportTips() {
  document.querySelectorAll('.info-tip--viewport').forEach((el) => {
    if (el.dataset.viewportTipWired === '1') return;
    el.dataset.viewportTipWired = '1';

    const scrollHost = el.closest('.right-panel-scroll');
    let listenersActive = false;
    let scrollRaf = 0;

    const place = () => {
      const r = el.getBoundingClientRect();
      const pad = 10;
      const maxW = 280;
      const w = Math.min(maxW, Math.max(160, window.innerWidth - 2 * pad));
      let left = r.right - w;
      left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
      el.setAttribute('data-tip-fixed', '');
      el.style.setProperty('--info-tip-x', `${left}px`);
      el.style.setProperty('--info-tip-y', `${r.bottom + 6}px`);
      el.style.setProperty('--info-tip-w', `${w}px`);
    };

    const clear = () => {
      el.removeAttribute('data-tip-fixed');
      el.style.removeProperty('--info-tip-x');
      el.style.removeProperty('--info-tip-y');
      el.style.removeProperty('--info-tip-w');
    };

    const onScrollOrResize = () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        place();
      });
    };

    const start = () => {
      place();
      if (listenersActive) return;
      listenersActive = true;
      window.addEventListener('scroll', onScrollOrResize, true);
      window.addEventListener('resize', onScrollOrResize);
      if (scrollHost) scrollHost.addEventListener('scroll', onScrollOrResize, { passive: true });
    };

    const stop = () => {
      if (!listenersActive) return;
      listenersActive = false;
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      if (scrollHost) scrollHost.removeEventListener('scroll', onScrollOrResize);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
      clear();
    };

    const considerHide = () => {
      requestAnimationFrame(() => {
        if (el.matches(':hover') || el === document.activeElement) return;
        stop();
      });
    };

    el.addEventListener('mouseenter', start);
    el.addEventListener('mouseleave', considerHide);
    el.addEventListener('focusin', start);
    el.addEventListener('focusout', considerHide);
  });
}

export function updateInfoTips(series) {
  if (!series) return;

  const src = series.anatomySource || 'default';

  // Anatomy regions button tooltip
  const infoRegions = document.getElementById('info-regions');
  if (infoRegions) {
    infoRegions.setAttribute('data-info', ANATOMY_TIPS[src] || ANATOMY_TIPS.default);
  }

  // Regional Volumes info line
  const volLine = document.getElementById('volumes-info-line');
  if (volLine) {
    volLine.textContent = VOLUME_LINE[src] || VOLUME_LINE.default;
  }

  // Regional Volumes tooltip on the section title
  const infoVolumes = document.getElementById('info-volumes');
  if (infoVolumes) {
    const model = src === 'synthseg' ? 'SynthSeg' : src === 'totalseg' ? 'TotalSegmentator' : 'unknown';
    infoVolumes.setAttribute(
      'data-info',
      `Volumes computed from voxel counts \u00d7 pixel spacing \u00d7 slice thickness. Model: ${model}. Not for clinical diagnosis.`
    );
  }
}

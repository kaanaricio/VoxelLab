// Confirm + clear all measurements / angles / ROIs / annotations on one slice.
import { state } from './state.js';
import { $, showDialog } from './dom.js';
import { drawSlice } from './slice-view.js';
import { drawMeasurements } from './measure.js';
import { renderAnnotationList } from './annotation.js';
import { drawSparkline } from './sparkline.js';
import { clearDrawingEntriesForSlice, drawingCountsForSlice } from './annotation-graph.js';

export function clearCurrentSliceDrawings() {
  const series = state.manifest.series[state.seriesIdx];
  const slug = series.slug;
  const z = state.sliceIdx;
  const counts = drawingCountsForSlice(state, slug, z);
  const nMeasure = counts.measurements;
  const nAngle = counts.angles;
  const nROI = counts.rois;
  const nAnnot = counts.notes;
  const total = counts.total;
  if (total === 0) return;

  const close = showDialog('Clear drawings', `
    <div class="dlg-sub-spaced">
      This will remove <b>${total}</b> item${total > 1 ? 's' : ''} on slice ${z + 1}:
      ${nMeasure ? `${nMeasure} ruler${nMeasure > 1 ? 's' : ''}, ` : ''}
      ${nAngle ? `${nAngle} angle${nAngle > 1 ? 's' : ''}, ` : ''}
      ${nROI ? `${nROI} ROI${nROI > 1 ? 's' : ''}, ` : ''}
      ${nAnnot ? `${nAnnot} annotation${nAnnot > 1 ? 's' : ''}` : ''}
    </div>
    <div class="dlg-actions">
      <button class="annot-btn" id="clear-cancel">Cancel</button>
      <button class="annot-btn danger" id="clear-confirm">Clear</button>
    </div>
  `);
  $('clear-cancel').onclick = close;
  $('clear-confirm').onclick = () => {
    clearDrawingEntriesForSlice(state, slug, z);
    close();
    drawSlice();
    drawMeasurements();
    renderAnnotationList();
    drawSparkline();
  };
}

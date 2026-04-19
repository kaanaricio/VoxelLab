import { $ } from './dom.js';
import { syncAskModeAfterViewChange } from './consult-ask.js';
import { clearROIMode } from './roi.js';
import { setAngleMode, setAnnotateMode, setAskMode, setMeasureMode } from './state/viewer-tool-commands.js';
import { setSlimSAMMode } from './slimsam-tool.js';

function syncButton(id, active) {
  $(id)?.classList.toggle('active', !!active);
}

export function deactivate2dAuthoringTools() {
  setMeasureMode(false);
  setAngleMode(false);
  setAnnotateMode(false);
  setAskMode(false);
  clearROIMode();
  setSlimSAMMode(false);
  syncButton('btn-measure', false);
  syncButton('btn-angle', false);
  syncButton('btn-annot', false);
  syncButton('btn-ask', false);
  syncButton('btn-roi-ell', false);
  syncButton('btn-roi-poly', false);
  syncButton('btn-slimsam', false);
  $('view-xform')?.classList.remove('measuring');
  $('view-xform')?.classList.remove('roi-mode');
  syncAskModeAfterViewChange();
}

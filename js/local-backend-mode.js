// Local-backend UI gating. Public/static builds keep upload and sidecar
// reads, but hide controls that require same-origin helper APIs.
import { $ } from './dom.js';
import { viewerAiFlags } from './config.js';

export function applyLocalBackendMode() {
  const flags = viewerAiFlags();
  const hideAiControls = !flags.localAiActionsEnabled;

  for (const id of ['btn-ask', 'btn-consult']) {
    const el = $(id);
    if (el) el.classList.toggle('hidden', hideAiControls);
  }
}

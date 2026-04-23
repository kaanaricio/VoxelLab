// Runtime configuration. Reads from a config.json at the site root
// (optional — falls back to sensible defaults). This is how open-source
// users configure their own Modal/R2/auth without modifying JS code.
//
// config.json format:
// {
//   "modalWebhookBase": "https://youruser--medical-imaging-pipeline",
//   "r2PublicUrl": "https://pub-xxx.r2.dev",
//   "trustedUploadOrigins": ["https://uploads.example.com"],
//   "localAiAvailable": true,
//   "ai": { "enabled": true, "provider": "codex", "ready": true, "issues": [] },
//   "siteName": "VoxelLab",
//   "disclaimer": "Not for clinical use.",
//   "features": {
//     "cloudProcessing": true,
//     "aiAnalysis": false
//   }
// }
//
// All fields are optional. Missing fields use defaults.

import { HAS_LOCAL_BACKEND } from './state.js';

let _config = null;

const DEFAULTS = {
  modalWebhookBase: '',
  r2PublicUrl: '',
  trustedUploadOrigins: [],
  localApiToken: '',
  localAiAvailable: true,
  ai: {
    enabled: true,
    provider: 'claude',
    ready: true,
    issues: [],
  },
  siteName: 'VoxelLab',
  disclaimer: 'Not for clinical use. For research and educational purposes only.',
  features: {
    cloudProcessing: true,
    aiAnalysis: true,
  },
};

export async function loadConfig() {
  if (_config) return _config;
  try {
    let r = await fetch('./config.local.json');
    if (!r.ok) r = await fetch('./config.json');
    if (r.ok) {
      const user = await r.json();
      _config = {
        ...DEFAULTS,
        ...user,
        trustedUploadOrigins: Array.isArray(user?.trustedUploadOrigins) ? user.trustedUploadOrigins : DEFAULTS.trustedUploadOrigins,
        ai: {
          ...DEFAULTS.ai,
          ...(user?.ai || {}),
          issues: Array.isArray(user?.ai?.issues) ? user.ai.issues : DEFAULTS.ai.issues,
        },
        features: { ...DEFAULTS.features, ...user.features },
      };
    } else {
      _config = { ...DEFAULTS };
    }
  } catch {
    _config = { ...DEFAULTS };
  }
  if (!_config.localApiToken && HAS_LOCAL_BACKEND) {
    try {
      const r = await fetch('/api/local-token');
      if (r.ok) {
        const tokenPayload = await r.json();
        if (typeof tokenPayload?.localApiToken === 'string') {
          _config = { ..._config, localApiToken: tokenPayload.localApiToken };
        }
      }
    } catch {
      // Same-origin local token fetch is best-effort; hosted/static paths do not have it.
    }
  }
  return _config;
}

export function getConfig() {
  return _config || DEFAULTS;
}

export function localApiHeaders(headers = {}) {
  const token = getConfig().localApiToken;
  return token ? { ...headers, 'X-VoxelLab-Local-Token': token } : { ...headers };
}

// Shape: flags for Ask/Consult/Analyze — gated by config + local backend presence.
export function buildAiUiFlags({ hasLocalBackend = true } = {}) {
  const cfg = getConfig();
  const analysisEnabled = cfg.features?.aiAnalysis !== false && cfg.ai?.enabled !== false;
  const localAiAvailable = cfg.localAiAvailable !== false && cfg.ai?.ready !== false;
  const aiUnavailableMessage = !analysisEnabled
    ? 'AI analysis is disabled in config.json.'
    : (cfg.ai?.issues?.[0] || 'Local AI actions are unavailable in this environment.');
  return {
    analysisEnabled,
    localAiAvailable,
    localAiActionsEnabled: hasLocalBackend && analysisEnabled && localAiAvailable,
    aiUnavailableMessage,
  };
}

/** AI UI flags for the in-browser viewer (`HAS_LOCAL_BACKEND` + current config). */
export function viewerAiFlags() {
  return buildAiUiFlags({ hasLocalBackend: HAS_LOCAL_BACKEND });
}

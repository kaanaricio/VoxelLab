// Shape: /?perf=1 => PERF_MODE === true.
//
// Perf mode is test/dev-only. It trims background warming so perf runs measure
// the interactive path instead of full remote-stack prefetch noise.

const params = new URLSearchParams(globalThis.location?.search || '');

export const PERF_MODE = (() => {
  const raw = params.get('perf');
  return raw === '1' || raw === 'true';
})();

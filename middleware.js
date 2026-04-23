// Vercel Edge Middleware — HTTP Basic Auth gate.
//
// Protects every URL (static files + any /api/*) behind a single shared
// password. The browser shows a native password prompt on first visit
// and remembers it for the tab session. Credentials are checked against
// the VIEWER_PASSWORD env var.
//
// This is the simplest auth that actually protects the data. Without
// middleware, static files would be directly fetchable by URL.
//
// Threat model:
//   ✓ blocks anonymous access to every URL (page + data files)
//   ✓ blocks cached proxy bypass (cache headers are `private`)
//   ✓ constant-time password comparison — no timing side channel
//   ✗ single password, no per-user revoke, no audit log
//   ✗ no rate limiting (relies on Vercel's infrastructure)
//   ✗ not HIPAA-compliant — Vercel hobby has no BAA

export const config = {
  // Run on every request except Vercel internals + the favicon.
  matcher: ['/((?!_vercel|favicon\\.ico|_next).*)'],
};

// Constant-time string comparison. Prevents a timing oracle where an
// attacker measures response latency to learn the password character by
// character. For 9-character passwords the difference is sub-millisecond
// but still a well-known class of mistake worth avoiding.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let mismatch = 0;
  const length = Math.max(a.length, b.length);
  mismatch |= a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="VoxelLab", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      // Don't let the 401 response get cached anywhere
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export default function middleware(request) {
  const expected = process.env.VIEWER_PASSWORD;
  if (!expected) {
    // Fail closed if not configured.
    return new Response(
      'VIEWER_PASSWORD env var is not set on this deployment.',
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const auth = request.headers.get('authorization');
  if (auth && auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      // Username is ignored — any username works, only the password matters.
      const i = decoded.indexOf(':');
      const pwd = i < 0 ? decoded : decoded.slice(i + 1);
      if (timingSafeEqual(pwd, expected)) {
        return; // pass through
      }
    } catch {
      // malformed Basic header → fall through to 401
    }
  }

  return unauthorized();
}

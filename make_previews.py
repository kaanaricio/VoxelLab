"""
Generate low-resolution preview volumes for instant 3D rendering.

Each series' .raw volume (uint16, full resolution) is downsampled to
~128³ and saved as a compact uint8 file that ships WITH the Vercel
deploy. When the user enters 3D mode, the preview loads in <100ms
and renders immediately. The full-res volume streams from R2 in the
background and swaps in seamlessly when ready.

Output: data/<slug>_preview.raw  (uint8, ~2-4 MB per series)
        Updates manifest.json with hasPreview: true + preview dimensions
"""

import argparse
import json
import sys
from pathlib import Path
import numpy as np

DATA = Path(__file__).parent / "data"
TARGET = 128  # max dimension in any axis


def downsample(vol, target_shape):
    """Simple block-average downsample. Not fancy but correct for previews."""
    D, H, W = vol.shape
    td, th, tw = target_shape
    # Block sizes
    bd = max(1, D // td)
    bh = max(1, H // th)
    bw = max(1, W // tw)
    # Trim to exact multiple
    vol = vol[:td * bd, :th * bh, :tw * bw]
    # Reshape and mean over blocks
    return vol.reshape(td, bd, th, bh, tw, bw).mean(axis=(1, 3, 5))


def process(series):
    slug = series["slug"]
    raw_path = DATA / f"{slug}.raw"
    if not raw_path.exists():
        return False

    W, H, D = series["width"], series["height"], series["slices"]
    u16 = np.fromfile(raw_path, dtype=np.uint16)
    if u16.size != W * H * D:
        print(f"  [skip] size mismatch: {u16.size} vs {W*H*D}", file=sys.stderr)
        return False

    vol = u16.reshape(D, H, W).astype(np.float32) / 65535.0

    # Compute target dimensions preserving aspect ratio
    max_dim = max(D, H, W)
    scale = TARGET / max_dim
    td = max(1, round(D * scale))
    th = max(1, round(H * scale))
    tw = max(1, round(W * scale))

    print(f"  {W}×{H}×{D} → {tw}×{th}×{td}")

    preview = downsample(vol, (td, th, tw))
    # Convert to uint8 for compact storage
    preview_u8 = (np.clip(preview, 0, 1) * 255).astype(np.uint8)

    out_path = DATA / f"{slug}_preview.raw"
    _ = out_path.write_bytes(preview_u8.tobytes())
    size_kb = out_path.stat().st_size / 1024
    print(f"  wrote {out_path.name} ({size_kb:.0f} KB)")

    series["hasPreview"] = True
    series["previewDims"] = [tw, th, td]
    return True


def main() -> bool:
    ap = argparse.ArgumentParser(description="Downsample .raw volumes to uint8 previews for fast 3D load.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series slugs (default: all with hasRaw)",
    )
    args = ap.parse_args()

    manifest_path = DATA / "manifest.json"
    m = json.loads(manifest_path.read_text())
    requested = set(args.slugs) if args.slugs else set()

    ok = True
    for s in m["series"]:
        if requested and s["slug"] not in requested:
            continue
        if not s.get("hasRaw"):
            continue
        print(f"\n=== {s['slug']} ===")
        try:
            _ = process(s)
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)
            ok = False

    _ = manifest_path.write_text(json.dumps(m, indent=2))
    print("\nDone.")
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)

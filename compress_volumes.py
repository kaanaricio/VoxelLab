"""
Compress every .raw volume (and _mask.raw) under data/ with Zstandard
for upload to Cloudflare R2. The browser decompresses on the fly using
fzstd, so on the hosted Vercel deploy the 3D renderer gets exactly the
same 16-bit precision volume it uses locally — without the viewer
carrying hundreds of megabytes of raw data in the deploy.

Input:   data/<slug>.raw                (uint16, little-endian, DHW layout)
         data/<slug>_mask.raw           (uint8 brain mask)
Output:  data_compressed/<slug>.raw.zst
         data_compressed/<slug>_mask.raw.zst
         data_compressed/index.json     (per-file size + sha256 + slug)

Why zstd --ultra -22 (WITHOUT --long):
 - CT volumes are dominated by air (HU -1024 → normalized 0) and smooth
   tissue plateaus. Uint16 deltas have long runs of repeated / near-
   repeated values. zstd's LZ77 + FSE entropy coder squeezes this hard.
 - --ultra -22 is the maximum quality level. It's slow to COMPRESS but
   decompression is the same speed as any other level (~500 MB/s),
   which is all that matters for the browser.
 - We do NOT use `--long` (extended window mode). fzstd — the tiny
   pure-JS decoder the browser uses — has a silent correctness bug
   when decoding streams compressed with --long=27: most bytes decode
   fine but a few KB near the end get corrupted. That is unacceptable
   for medical data where every voxel matters. Without --long we lose
   only ~3% compression ratio. Every compressed file is re-decoded and
   byte-compared against the source before being declared good.

Typical expected ratios (zstd -22 --ultra, no --long):
   Large CT volume   148 MB  →  ~50-55 MB
   Medium CT volume  114 MB  →  ~40-45 MB
   Brain MR volume    14 MB  →   ~4.5 MB
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Directory containing the `fzstd` npm package (e.g. .../node_modules/fzstd or path to parent node_modules).
ENV_FZSTD_NODE = "VOXELLAB_FZSTD_NODE_PATH"
LEGACY_ENV_FZSTD_NODE = "MRI_VIEWER_FZSTD_NODE_PATH"

ROOT = Path(__file__).parent
DATA = ROOT / "data"
OUT = ROOT / "data_compressed"

# Compression level. We default to 19 because benchmarks on this corpus
# showed level 22 saves only ~0.02% more bytes while taking 3-4× longer
# to compress. Decompression speed is identical at any level. Override
# with `python3 compress_volumes.py --level 22` to squeeze the last
# few bytes if you really want to.
DEFAULT_LEVEL = 19

_FZSTD_SKIP_LOGGED = False


def have_zstd() -> bool:
    return shutil.which("zstd") is not None


def zstd_compress(src: Path, dst: Path, level: int) -> None:
    """Compress src → dst using the zstd CLI. Intentionally does NOT
    pass --long — see module docstring for the fzstd correctness bug.
    """
    cmd = [
        "zstd",
        f"-{level}",
        "--ultra",
        "-f",        # overwrite existing
        "-q",        # quiet
        str(src),
        "-o",
        str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"zstd failed on {src.name}: {result.stderr}")


def zstd_verify(src: Path, dst: Path) -> None:
    """Decompress dst back to bytes and compare to src byte-for-byte
    using the reference zstd CLI. Raises RuntimeError on any mismatch.
    """
    decompress_cmd = ["zstd", "-d", "-c", "-q", str(dst)]
    result = subprocess.run(decompress_cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"zstd verify decompress failed on {dst.name}: "
            + f"{result.stderr.decode(errors='replace')}"
        )
    with src.open("rb") as f:
        original = f.read()
    if len(original) != len(result.stdout):
        raise RuntimeError(
            f"size mismatch after roundtrip: {src.name} "
            + f"{len(original)} bytes → decompressed {len(result.stdout)} bytes"
        )
    if original != result.stdout:
        for i in range(len(original)):
            if original[i] != result.stdout[i]:
                raise RuntimeError(
                    f"byte-exact verify FAILED on {src.name}: "
                    + f"first diff at offset {i}"
                )
        raise RuntimeError(f"unknown verify failure on {src.name}")


def fzstd_verify(src: Path, dst: Path) -> None:
    """Also verify via fzstd — the same JS decoder the browser uses.
    This is the real correctness check because the zstd CLI and fzstd
    can disagree on certain inputs (the reason we dropped --long mode).

    Requires node + the fzstd package. Set MRI_VIEWER_FZSTD_NODE_PATH to the
    directory that contains the package (e.g. .../node_modules/fzstd).
    Silently skips if unavailable so CI without node still works, but
    prints a warning so the user knows the check didn't run.
    """
    node = shutil.which("node")
    global _FZSTD_SKIP_LOGGED
    raw = (os.environ.get(ENV_FZSTD_NODE) or os.environ.get(LEGACY_ENV_FZSTD_NODE) or "").strip()
    fzstd_pkg = Path(raw) if raw else None
    if not fzstd_pkg or not fzstd_pkg.exists():
        if not _FZSTD_SKIP_LOGGED:
            print(
                f"    [warn] fzstd JS check skipped "
                + f"(set {ENV_FZSTD_NODE} to node_modules/fzstd and ensure node is on PATH)",
                file=sys.stderr,
            )
            _FZSTD_SKIP_LOGGED = True
        return
    if not node:
        if not _FZSTD_SKIP_LOGGED:
            print(
                "    [warn] fzstd JS check skipped (node not on PATH)",
                file=sys.stderr,
            )
            _FZSTD_SKIP_LOGGED = True
        return
    # Escape backslashes for require() on Windows
    req_path = str(fzstd_pkg.resolve()).replace("\\", "\\\\")
    script = (
        "const fs=require('fs');"
        f"const fzstd=require({json.dumps(req_path)});"
        "const c=fs.readFileSync(process.argv[1]);"
        "const o=fzstd.decompress(c);"
        "const orig=fs.readFileSync(process.argv[2]);"
        "if(o.length!==orig.length){console.error('len mismatch',o.length,orig.length);process.exit(2);}"
        "const buf=Buffer.from(o.buffer,o.byteOffset,o.byteLength);"
        "for(let i=0;i<orig.length;i++){if(orig[i]!==buf[i]){console.error('diff at',i);process.exit(3);}}"
        "console.log('OK');"
    )
    result = subprocess.run(
        [node, "-e", script, str(dst), str(src)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"fzstd verify FAILED on {src.name}: "
            + f"{result.stderr.strip() or result.stdout.strip()}"
        )


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> bool:
    ap = argparse.ArgumentParser(description="Compress data/*.raw volumes with zstd for R2 upload.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Volume stem names (e.g. flair, ct_1); default: all .raw in data/",
    )
    _ = ap.add_argument(
        "--level",
        type=int,
        default=DEFAULT_LEVEL,
        metavar="N",
        help=f"zstd level (default: {DEFAULT_LEVEL})",
    )
    args = ap.parse_args()
    level = args.level

    if not have_zstd():
        print("ERROR: zstd CLI not found on PATH. Install it first:", file=sys.stderr)
        print("  brew install zstd", file=sys.stderr)
        return False

    OUT.mkdir(exist_ok=True)

    # Enumerate .raw files — the main 16-bit volumes. We intentionally
    # SKIP *_mask.raw files: the viewer uses the 8-bit PNG-derived voxel
    # grid (loaded from data/<slug>_brain/) as the brain mask at runtime,
    # not the _mask.raw binaries. Those are build artifacts only.
    raw_files = sorted(p for p in DATA.glob("*.raw") if not p.stem.endswith("_mask"))
    if args.slugs:
        wanted = set(args.slugs)
        raw_files = [p for p in raw_files if p.stem in wanted or p.name in wanted]
    if not raw_files:
        print("no .raw files found — nothing to do")
        return True

    index: dict[str, dict] = {}
    total_src = 0
    total_dst = 0
    ok = True
    print(f"compressing {len(raw_files)} volumes at zstd level {level} ...")
    for src in raw_files:
        dst = OUT / f"{src.name}.zst"
        try:
            zstd_compress(src, dst, level)
            # ALWAYS roundtrip-verify before declaring success. Medical data
            # cannot tolerate silent corruption from a buggy decoder path.
            # Two layers: (1) zstd CLI self-check, (2) fzstd decoder check —
            # because the CLI and the browser JS decoder can disagree on
            # edge cases (e.g. --long mode).
            zstd_verify(src, dst)
            fzstd_verify(src, dst)
        except Exception as e:
            print(f"ERROR: {src.name}: {e}", file=sys.stderr)
            ok = False
            continue
        src_sz = src.stat().st_size
        dst_sz = dst.stat().st_size
        ratio = src_sz / dst_sz if dst_sz else 0
        total_src += src_sz
        total_dst += dst_sz
        # stem strips ".raw" → slug; name keeps it → filename
        key = src.stem  # e.g. "flair" or "flair_mask"
        index[key] = {
            "source": src.name,
            "compressed": dst.name,
            "src_bytes": src_sz,
            "zst_bytes": dst_sz,
            "sha256_src": sha256_of(src),
            "sha256_zst": sha256_of(dst),
        }
        print(
            f"  {src.name:30s}  {src_sz / 1024 / 1024:6.1f} MB → "
            + f"{dst_sz / 1024 / 1024:6.1f} MB  ({ratio:.1f}×)"
        )

    index_path = OUT / "index.json"
    _ = index_path.write_text(json.dumps(index, indent=2, sort_keys=True))
    print(
        f"\ntotal: {total_src / 1024 / 1024:.1f} MB → "
        + f"{total_dst / 1024 / 1024:.1f} MB  "
        + f"({total_src / total_dst:.2f}× overall)"
    )
    print(f"wrote {index_path}")
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)

# Cloudflare R2 and Modal Setup

VoxelLab can run without R2 or Modal. Use this guide only when you want hosted raw volumes, browser uploads, or cloud-processed CT/MR studies.

R2 stores files that should not live in a static web deploy: full-resolution `.raw.zst` volumes, processed overlays, and Modal job outputs. The checked-in PNG stacks still work without it, but high-fidelity 3D and cloud-generated series need remote storage.

## What You Need

- A Cloudflare account with R2 enabled
- A Modal account for GPU processing
- Node.js 20+
- Python 3.11+
- The `zstd` CLI for local raw-volume compression
- Vercel CLI only if you deploy with Vercel

Install VoxelLab dependencies with cloud extras:

```bash
npm run setup -- --cloud
```

## Create the R2 Bucket

1. Open the Cloudflare dashboard.
2. Go to **R2**.
3. Create a bucket. VoxelLab defaults to `scan-data` when `R2_BUCKET` is not set.
4. Enable read-only public access through an `r2.dev` subdomain or a custom domain.
5. Copy the public base URL without a trailing slash.

Example:

```sh
R2_PUBLIC_URL=https://pub-<hash>.r2.dev
```

## Create Local Secrets

Create a local `.env` file in the repo root. Do not commit it.

```sh
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=scan-data
R2_PUBLIC_URL=https://<public-r2-host>

MODAL_WEBHOOK_BASE=https://<workspace>--medical-imaging-pipeline
MODAL_AUTH_TOKEN=<shared-modal-token>
VIEWER_PASSWORD=<optional-deploy-password>
SITE_NAME=VoxelLab
```

Use Cloudflare's S3-compatible R2 credentials, not your Cloudflare account token.

## CORS for Browser Uploads

Direct browser uploads use presigned PUT URLs. Add CORS for your local and deployed origins:

```json
[{
  "AllowedOrigins": ["http://127.0.0.1:8000", "https://viewer.example.com"],
  "AllowedMethods": ["GET", "HEAD", "PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3600
}]
```

Public reads may work without this rule, but browser uploads need it.

## Deploy Modal

Activate your venv so the Modal CLI installed by `npm run setup -- --cloud` is on your shell path:

```bash
. .venv/bin/activate
modal deploy modal_app.py
```

Then run the preflight:

```bash
npm run check:cloud
```

`npm run check:cloud` checks required R2 env vars and expected local executables. It is a dry run and does not upload or mutate cloud resources.

## Process a Local Study

```bash
npm run modal:submit -- /path/to/dicoms --job-id my_job_001 --modality auto
node scripts/run_python.mjs scripts/merge_modal_result.py --r2-public-url "$R2_PUBLIC_URL" --job-id my_job_001
```

The browser **Upload study** button uses the same flow:

1. Request presigned R2 upload URLs.
2. Upload DICOM files directly to R2.
3. Start Modal processing.
4. Poll Modal status.
5. Load the returned `results/<job_id>/series.json`.

CT/MR volume-stack processing is the supported path. Projection-set reconstruction validates request shape and fails closed. It does not reconstruct CBCT or tomosynthesis projections yet.

## Per-Release Raw Volume Workflow

After changing `.raw` volumes, for example after `rehires.py` or `convert_ct.py`:

```bash
# 1. Compress every .raw into .raw.zst with verification.
python3 compress_volumes.py

# 2. Upload to R2. Existing files are skipped.
#    This can patch data/manifest.json with rawUrl / maskUrl fields.
python3 upload_to_r2.py

# 3. Deploy. Set MODAL_WEBHOOK_BASE, R2_PUBLIC_URL, and VIEWER_PASSWORD
#    in the deployment environment before npm run build.
vercel deploy --prod --yes
```

## Modal Tuning

`modal_app.py` reads environment variables so users can tune cost, speed, and resource limits without editing code.

| Variable | Default | Purpose |
|---|---:|---|
| `MRI_VIEWER_MODAL_GPU` | `T4` | GPU selector for heavy processing. Use `none` for CPU-only experiments or comma-separated fallbacks such as `L4,A10G`. |
| `MRI_VIEWER_MODAL_CPU` | `4` | Physical CPU cores requested for the processing container. |
| `MRI_VIEWER_MODAL_MEMORY_MB` | `16384` | Guaranteed memory for DICOM decode, raw-volume writes, and segmentation. |
| `MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB` | `204800` | Temporary SSD quota for DICOMs, PNGs, raw volumes, NIfTI, and segmentation outputs. |
| `MRI_VIEWER_MODAL_MAX_CONTAINERS` | `10` | Maximum concurrent processing containers. Raise this only when your Modal and R2 quotas can absorb it. |
| `MRI_VIEWER_R2_TRANSFER_WORKERS` | `8` | Per-job parallel R2 download/upload workers, capped at 64. |
| `MRI_VIEWER_MODAL_RETRIES` | `1` | Retry count for processing-job infrastructure flakes. Set to `0` to disable. |

The web endpoints use separate `MRI_VIEWER_MODAL_WEB_*` CPU, memory, timeout, container, and retry settings. They default to lightweight containers because `start_processing` should return quickly and the browser polls `check_status` for the long job.

## Compression Correctness

`compress_volumes.py` verifies each compressed file twice before treating it as safe:

1. The reference `zstd` CLI decompresses the file and compares bytes to the source.
2. `fzstd`, the JS decoder used in the browser, decompresses the file and compares bytes to the source.

Both must pass. This matters because the browser decoder is the thing users actually depend on. A past `--long=27` compression mode decoded correctly with the `zstd` CLI but corrupted bytes under `fzstd`, so long-window compression is disabled.

If the `fzstd` check is skipped because Node or the package is missing, install it and rerun:

```bash
cd /tmp
npm install fzstd
```

## Security

- `.env` contains R2 and Modal secrets. It must stay local.
- Rotate credentials if they were pasted into chat, logs, screenshots, or issue text.
- Public bucket access is read-only.
- Browser uploads use short-lived presigned PUT URLs for specific keys. They do not expose R2 credentials.
- Local upload scripts use the authenticated S3 API from `.env`.

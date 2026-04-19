# VoxelLab

[![Check](https://github.com/kaanaricio/VoxelLab/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/kaanaricio/VoxelLab/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A local-first research viewer for medical image volumes, with optional advanced processing engines.**

VoxelLab is a no-build web app for opening DICOM, NIfTI, and manifest-backed PNG/raw volume stacks in the browser. It can run as a simple local viewer, or as a broader research pipeline with optional Python tooling, Modal GPU processing, and Cloudflare R2 volume hosting.

> **Not for clinical use.** VoxelLab is for research and education. It is not a medical device, PACS workstation, DICOMweb server, diagnostic system, calibrated display, or regulatory-cleared workflow.

## Project and community

| | |
|---|---|
| **License** | [MIT](LICENSE) (includes a non-clinical disclaimer). |
| **Contributing** | [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security policy](SECURITY.md) |
| **Changelog** | [CHANGELOG.md](CHANGELOG.md) |
| **Architecture** | High-level design: [ARCHITECTURE.md](ARCHITECTURE.md) |
| **CI** | [`.github/workflows/check.yml`](.github/workflows/check.yml) runs `npm run check` on pushes and PRs to `main` / `master`. |
| **Releases** | Public snapshots are intended to ship as tagged `v*` GitHub releases so the sanitized export still has audit-friendly checkpoints. |
| **Privacy (default)** | Drag-and-drop and local viewing stay in your browser unless you explicitly enable optional cloud processing; see [Optional Cloud GPU Processing](#optional-cloud-gpu-processing). |

**Non-goals (summary):** VoxelLab is **not** a regulated medical device, a full **PACS** replacement, or a promise of universal DICOM interoperability—the [capability table](#capability-boundaries) and [accuracy policy](#accuracy-policy) define what is supported. Detailed planning notes for maintainers live under `docs/` in this repo and are **not** part of the sanitized public export.

## Public Release Model

The public GitHub repo is a sanitized rolling export, not the full private working tree. Public trust checkpoints are meant to come from tagged `v*` releases plus the `npm run check` gate, while `main` stays a clean current snapshot.

If you are reading the sanitized public export, maintainer-only sync helpers such as `npm run sync:public` are intentionally absent there. Public users should consume tagged releases or the current snapshot; public contributors should use the normal clone, `npm run setup`, `npm run check`, and PR workflow.

## What You Can Do

| Task | Support |
|---|---|
| View supported volumes | 2D slices, axial/coronal/sagittal/oblique MPR, 3D volume rendering, and side-by-side compare for volumetric series with trustworthy patient-space geometry |
| Open local files | Drag-and-drop DICOM and NIfTI files in the browser. Local import stays local unless you explicitly use Cloud GPU. Unsupported DICOM classes stay 2D or fail closed. |
| Measure | Distance, angle, ellipse, and polygon ROIs with physical units, plus lightweight viewer-oriented DICOM SR note export and re-import for VoxelLab-exported notes with explicit series/slice references |
| Explore overlays | Tissue maps, region overlays, symmetry heatmaps, analysis sidecars, and SlimSAM click-to-segment when embeddings exist |
| Process studies | Optional SynthSeg, TotalSegmentator, tissue classification, biomarker scripts, and Modal/R2 processing for supported CT/MR stacks plus calibrated projection and ultrasound reconstruction jobs |
| Customize | Edit `config.json`, the manifest, HTML/CSS, or the plugin API without adding a bundler |

## Stable Path vs Advanced Engines

VoxelLab has one product surface, but not every path is equally mature yet.

- **Stable path:** local DICOM/NIfTI viewing, patient-space geometry, 2D slices, MPR, 3D volume rendering, measurements, compare, overlays, and VoxelLab-exported viewer-style SR note round-tripping with explicit series/slice references.
- **Advanced engines:** optional Python pipelines, Modal/R2 processing, calibrated projection reconstruction, calibrated ultrasound scan conversion, and broader DICOMweb / derived-object workflows.
- **Meaning of advanced:** these paths are real and supported where explicitly documented, but they have more environment setup, narrower input contracts, and less real-world interoperability coverage than the core local viewer.

## Start In 2 Commands

Prerequisites:

- Node.js 20+
- Python 3.11+

For most users:

```bash
git clone https://github.com/kaanaricio/VoxelLab.git
cd VoxelLab
npm run setup
npm start
```

Open http://localhost:8000.

Interactive setup asks what public demo data to install. The default is the shipped lite MRI pack with pregenerated artifacts, so first-time users can see the real viewer, MPR, 3D, overlays, and AI sidecars without generating anything or touching private data. The lite pack is about 44 MB to download and about 82 MB unpacked. No cloud account is needed.

## Choose Your Path

If you just want to try VoxelLab with example data:

1. Run `npm run setup`
2. Leave the default lite MRI demo option enabled
3. Run `npm start`
4. Open http://localhost:8000

If you want to use your own data right away:

1. Run `npm run setup`
2. Run `npm start`
3. Open http://localhost:8000
4. Drag a DICOM folder, DICOM files, or a `.nii` / `.nii.gz` file into the page

Everything in that path stays local unless you explicitly turn on cloud processing.

If you want the current public support boundary in one place, use the support table below. The working repo keeps a deeper validation ledger behind that summary.

If you downloaded the repo as a ZIP, open a terminal in the unzipped folder and run the same two commands:

```bash
npm run setup
npm start
```

If you only want the static viewer and already have Python installed, this also works:

```bash
python3 serve.py
```

## Optional Setup Paths

`npm run setup` creates `.venv`, installs Python dev dependencies, installs npm dependencies, installs the Chromium browser used by Playwright tests, and offers optional public demo data downloads.

Interactive setup asks three storage-sensitive questions:

- install the shipped lite MRI artifact pack
- download the public MRI source files too
- download the public CT source files too

Non-interactive runs stay conservative: without explicit demo flags, setup skips demo downloads.

If you want optional local processing and cloud tooling:

```bash
npm run setup -- --pipeline --cloud
```

If you want calibrated projection reconstruction with the bundled RTK runtime:

```bash
npm run setup -- --pipeline --rtk
```

If you want local AI tooling with an explicit provider check:

```bash
npm run setup -- --ai --provider claude
```

Codex stays supported:

```bash
npm run setup -- --ai --provider codex
```

Non-interactive demo install examples:

```bash
npm run setup -- --demo lite
npm run setup -- --demo none --with-mri
npm run setup -- --demo lite --with-ct
```

Useful skip flags:

```bash
npm run setup -- --skip-playwright
npm run setup -- --skip-python
npm run setup -- --skip-npm
```

## Open Your Own Data

Fast path for local files:

1. Start the server with `npm start`.
2. Open http://localhost:8000.
3. Drag DICOM files, a DICOM folder, or a `.nii` / `.nii.gz` file into the viewer.
4. Or open **Upload study** and use the DICOMweb section with a WADO-RS base URL, Study UID, and Series UID.

Local imports stay in the browser. The Cloud GPU path is opt-in.

If you only want to play with the shipped example data, install the public packs instead of hand-editing local manifests:

```bash
npm run demo:install -- --demo lite
npm run demo:install -- --demo none --with-mri
npm run demo:install -- --demo none --with-ct
```

`demo_packs/catalog.json` defines the shipped lite pack and the optional public source packs.

## Capability Boundaries

| Input | Current support | Boundary |
|---|---|---|
| Single-frame CT and MR DICOM slice stacks | 2D, MPR, 3D, compare, measurements, and pipeline-derived overlays when stack geometry is consistent | Research/demo viewer only, not clinical DICOM conformance |
| Enhanced multi-frame CT/MR DICOM | Local/browser and cloud paths expand per-frame geometry and pixels into the shared stack pipeline when frame payloads are directly retrievable | Irregular spacing stays 2D-only, and broader compressed-transfer/DICOMweb edge cases still need more validation |
| Ultrasound / ECHO DICOM | Single-frame and multi-frame cine can be opened as 2D image stacks; calibrated ultrasound sources can be sent to the optional advanced Modal scan-conversion engine | Raw ultrasound stays 2D-only in the browser; volumetric use requires an explicit `voxellab.source.json` calibration manifest and remains an advanced path |
| NIfTI `.nii` / `.nii.gz` | Browser-local volumetric import | Narrower metadata and provenance than a clinical workflow |
| Manifest PNG/raw stacks | Checked-in demo format with optional raw-volume and cloud sidecars | Internal prototype format, not an interchange standard |
| Single projection X-ray / CR / DX | 2D display only when imported as image data | Cannot become true 3D from one projection |
| Calibrated projection sets | Calibrated projection jobs can be sent to the optional advanced Modal reconstruction engine, which returns a derived volume plus a registered source projection set | Current engine scope is explicit calibrated parallel-beam style reconstruction; uncalibrated or mixed projection uploads still fail closed |
| DICOM SEG / RTSTRUCT / RT Dose | Session-backed SEG import can bind to a loaded source series as a region overlay; CLOSED_PLANAR RTSTRUCT contours can bind as ROIs; RT Dose metadata can bind as a persisted derived record when browser storage is available | Dose-grid rendering and a full clinical RT workflow are still incomplete, and imported SEG currently uses the region-overlay slot |
| DICOM SR | Lightweight viewer-oriented measurement export exists, and VoxelLab-exported SR notes with explicit series/slice references can be re-imported as session annotations | This is still not generic clinical SR ingestion or a complete SR round-trip workflow |
| PACS / DICOMweb | WADO-RS metadata normalization, per-frame fetch adapters, and session import for supported image plus SEG/RTSTRUCT and VoxelLab-exported SR note series | Still an advanced interoperability path, not a production-complete study ingest, auth, cache, or interoperability stack |

3D rendering works from already reconstructed volumetric slice stacks such as CT, MR, tomosynthesis outputs, or uploaded multi-slice DICOM/NIfTI series with consistent voxel geometry. The viewer does not infer 3D from slice count, `NumberOfFrames`, or projection modality alone. A single projection X-ray cannot be reconstructed into a true 3D volume without calibrated multi-view projection geometry.

The table above is the public-facing support boundary. The working repo keeps a deeper claim-to-proof matrix behind it.

## Accuracy Policy

- One shared patient-space geometry contract drives browser import, MPR, 3D scaling, measurements, compare mode, Python conversion, and cloud processing.
- Slice ordering uses patient position and orientation when available. `InstanceNumber` is only a fallback tie-breaker.
- `FrameOfReferenceUID` is the primary compare/overlay identity when present.
- Unsupported inputs fail closed instead of being silently coerced into a volume.

The shared geometry modules live in `js/geometry.js` and `geometry.py`.

## Customize VoxelLab

Edit `config.json` for public-safe runtime settings:

```json
{
  "modalWebhookBase": "",
  "r2PublicUrl": "",
  "siteName": "VoxelLab",
  "disclaimer": "Not for clinical use. For research and educational purposes only.",
  "features": {
    "cloudProcessing": false,
    "aiAnalysis": true
  }
}
```

For local private values, create a `.env` file. Keep it out of git.

```sh
SITE_NAME=VoxelLab
VOXELLAB_AI_PROVIDER=claude
MODAL_WEBHOOK_BASE=https://<workspace>--medical-imaging-pipeline
MODAL_AUTH_TOKEN=<shared-modal-token>
R2_PUBLIC_URL=https://<public-r2-host>
VIEWER_PASSWORD=<deployment-password>
```

`serve.py` overlays `.env` values onto `/config.json` for local work. Vercel builds can use deployment environment variables to render the same public runtime config.

For UI verification, `?localBackend=0` forces the static/public "no local backend" path and `?localBackend=1` forces the local-helper-API path on custom dev hosts. The legacy `?hosted=1|0` override still works, but `localBackend` is the preferred name.

For UI changes, edit `index.html` and the ES modules in `js/`. There is no bundler.

## Optional Cloud GPU Processing

Use this when you want uploaded CT/MR studies to be processed outside the browser. This is an advanced path, not the default viewer flow:

1. Create a Modal account and a Cloudflare R2 bucket.
2. Run `npm run setup -- --cloud`.
3. Create a local `.env` with your R2 credentials, `R2_PUBLIC_URL`, `MODAL_WEBHOOK_BASE`, and `MODAL_AUTH_TOKEN`.
4. Deploy the Modal app from your activated venv: `modal deploy modal_app.py`.
5. Start VoxelLab with `npm start`.
6. Click **Upload study**, or submit a local folder:

```bash
npm run modal:submit -- /path/to/dicoms --job-id my_job_001 --modality auto
node scripts/run_python.mjs scripts/merge_modal_result.py --r2-public-url "$R2_PUBLIC_URL" --job-id my_job_001
```

Projection-set reconstruction and ultrasound scan conversion both require an explicit `voxellab.source.json` calibration sidecar:

```bash
npm run modal:submit -- /path/to/projections --job-id projection_job_001 --modality auto --processing-mode projection_set_reconstruction --input-kind calibrated_projection_set
npm run modal:submit -- /path/to/ultrasound --job-id ultrasound_job_001 --modality auto --processing-mode ultrasound_scan_conversion --input-kind calibrated_ultrasound_source
```

The default real RTK runtime is the bundled Python wrapper in `scripts/rtk_projection_wrapper.py`, backed by `itk-rtk`. Install it with `npm run setup -- --pipeline --rtk`. `MRI_VIEWER_RTK_COMMAND` is still available if you want to override that default with a different RTK wrapper command. If no RTK runtime is available, non-parallel projection jobs fail closed instead of being approximated.

The Modal submitter now runs the same calibrated-source preflight locally before upload for projection and ultrasound jobs, so missing sidecars or missing RTK runtime fail early instead of after a long upload.

Local and DICOMweb derived-object imports stay session-backed. SEG overlays bind to an already loaded source series, RTSTRUCT contours become ROIs on that source series, VoxelLab-exported viewer-style SR notes with explicit `<slug> slice N` references become annotations, and RT Dose can bind as persisted metadata when browser storage is available. These imports do not rewrite `data/manifest.json`.

See `R2_SETUP.md` for R2 bucket setup, CORS, compression, and deployment notes.

## Local Processing Scripts

Supported local pipelines include `convert.py`, `convert_ct.py`, `brain_extract.py`, `segment.py`, `synthseg_pipeline.py`, and `totalseg_pipeline.py`.

Research helpers with narrower assumptions:

- `biomarkers.py` and `register.py` still target the repo's current MR series slugs (`swi_3d`, `flair`, `t1_se`, `t2_tse`, `dwi_adc`) plus manifest `sourceFolder` conventions.
- Treat those two scripts as example or known-dataset helpers, not as a general-purpose ingestion or registration subsystem.
- The core local viewer, geometry contract, and documented conversion/pipeline commands remain the public support baseline.

For MR:

```bash
python3 convert.py -s /path/to/dicoms
python3 brain_extract.py
python3 segment.py
python3 synthseg_pipeline.py
python3 rehires.py
```

`SynthSeg` stays optional in the OSS repo. VoxelLab prefers a local `mri_synthseg` install when present, and otherwise the pipeline can fetch the upstream SynthSeg repo into a local runtime checkout on demand. The public repo does not bundle `synthseg_repo/`.

For CT:

```bash
python3 convert_ct.py -s /path/to/dicoms
python3 totalseg_pipeline.py ct
```

Before long runs, dry-run the expected toolchain:

```bash
PYTHON=/tmp/tsenv/bin/python3 PATH="/tmp/tsenv/bin:$PATH" MRI_VIEWER_DICOM_ROOT=/path/to/dicom npm run check:pipeline -- --no-synthseg
PYTHON=/tmp/synthseg_env/bin/python MRI_VIEWER_DICOM_ROOT=/path/to/dicom npm run check:pipeline -- --no-ct
npm run check:pipeline -- --projection-source /path/to/projections --ultrasound-source /path/to/ultrasound
```

## Develop

```bash
npm run check
npm run check:geometry
npm run test:browser
npm run ai:doctor -- --provider claude
```

`npm run check` runs JS lint/syntax, Python compile checks, manifest checks, shared geometry parity checks, Python tests, Node tests, and Playwright browser smoke tests. It does not upload to R2, run Modal GPU jobs, call AI providers, or run full compressed-volume release checks.

AI setup is intentionally explicit. `npm run ai:doctor` verifies the selected local provider and fails closed if the CLI is missing, unauthenticated, or misconfigured. `npm run ai:refresh -- --provider claude` regenerates context sidecars, grounded analysis, and consult output for installed public demo data. Codex remains an optional provider.

Architecture:

```text
Browser (static site)          Cloud (optional)
|-- index.html                 |-- Vercel static hosting/auth
|-- viewer.js                  |-- Cloudflare R2 volume storage
|-- js/ modules                `-- Modal GPU processing
`-- Three.js + Canvas2D + GLSL

Python pipeline (local)
|-- convert.py, convert_ct.py  -> DICOM to PNG/raw
|-- brain_extract.py           -> HD-BET skull stripping
|-- segment.py                 -> tissue classification
|-- synthseg_pipeline.py       -> SynthSeg brain parcellation
|-- totalseg_pipeline.py       -> TotalSegmentator CT organs
|-- biomarkers.py              -> SWI/FLAIR/DWI analysis
`-- compress_volumes.py        -> zstd compression for R2 upload
```

## Plugin API

External code can extend the viewer without modifying core files:

```js
import { registerPlugin } from './js/plugin.js';

registerPlugin({
  name: 'my-analysis',
  init(api) {
    api.addPanel({
      id: 'my-panel',
      title: 'My Analysis',
      render(el) {
        el.textContent = 'Ready';
      },
    });
    api.onSliceChange((sliceIdx, seriesIdx) => {
      console.log({ sliceIdx, seriesIdx });
    });
  },
});
```

## Project Docs

| File | Purpose |
|---|---|
| `ARCHITECTURE.md` | Public architecture, geometry contract, and capability boundaries |
| `CONTRIBUTING.md` | Contributor setup, code map, and test commands |
| `R2_SETUP.md` | Cloudflare R2, Modal, compression, and deployment notes |

## Credits

- [SynthSeg](https://github.com/BBillot/SynthSeg), Billot et al., *Medical Image Analysis*, 2023
- [TotalSegmentator](https://github.com/wasserth/TotalSegmentator), Wasserthal et al., *Radiology: AI*, 2023
- [HD-BET](https://github.com/MIC-DKFZ/HD-BET), Isensee et al., MIC-DKFZ

## License

MIT. See `LICENSE`.

**Medical disclaimer:** This software is not a medical device. All AI-generated overlays, observations, and measurements are for research and educational purposes only. Always consult a qualified healthcare professional for medical decisions.

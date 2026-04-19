# Contributing

VoxelLab is intentionally simple to run and simple to change. The browser app is static HTML plus ES modules. The Python side handles local tooling, tests, and optional medical imaging pipelines.

If you are here to run the app with demo data or your own scans, use the fast path in `README.md` first. This file is for changing the repo after the app is already running.

Everyone participating in issues and pull requests is expected to follow the **[Code of Conduct](CODE_OF_CONDUCT.md)**. Report security issues per **[SECURITY.md](SECURITY.md)** (not public issues). Release notes for contributors accumulate in **[CHANGELOG.md](CHANGELOG.md)**. Maintainer-facing roadmap and scope notes live under **`docs/`** (excluded from the public GitHub export workflow).

## Quick Start

Prerequisites:

- Node.js 20+
- Python 3.11+

```bash
git clone https://github.com/kaanaricio/VoxelLab.git
cd VoxelLab
npm run setup
npm start
```

Open http://localhost:8000.

For the full fast suite:

```bash
npm run check
```

The public support boundary is summarized in `README.md`. If you change a public support claim in the working repo, keep the deeper validation ledger in sync too.

For optional local pipeline or cloud tooling dependencies:

```bash
npm run setup -- --pipeline --cloud
```

For calibrated projection reconstruction with the bundled RTK runtime:

```bash
npm run setup -- --pipeline --rtk
```

For local AI tooling with an explicit provider check:

```bash
npm run setup -- --ai --provider claude
```

Codex stays supported when you want it:

```bash
npm run setup -- --ai --provider codex
```

Interactive setup also asks whether to install:

- the shipped lite MRI demo pack with pregenerated artifacts
- the public MRI source files
- the public CT source files

For scripted installs:

```bash
npm run setup -- --demo lite
npm run setup -- --demo none --with-mri
npm run setup -- --demo lite --with-ct
```

If you only need to open the static viewer, `python3 serve.py` is enough.

## Code Map

| Path | What |
|---|---|
| `index.html` | All HTML and CSS. No build step, no bundler. |
| `viewer.js` | Composition root. Initializes shared state and wires modules together. |
| `js/` | ES modules for rendering, imports, controls, cloud upload, series selection, overlays, compare, and plugins. |
| `scripts/` | Setup, validation, config rendering, Modal submitter, and release helpers. |
| `demo_packs/` | Public demo-pack catalog plus the shipped lite artifact archive. |
| `js/geometry.js` + `geometry.py` | Shared patient-space geometry contract used by browser, Python, and cloud paths. |
| `js/dicomweb/dicomweb-source.js` | WADO-RS metadata normalization and per-frame fetch helpers for the shared import path. |
| `js/derived-objects.js` | Canonical derived-object binding and affine/FoR compatibility rules. |
| `js/dicom-derived-import.js` | Session-backed SEG / RTSTRUCT / SR import path plus RT Dose summary binding for already loaded source series. |
| `js/ultrasound.js` | Ultrasound cine classification, calibration summaries, and the browser-side boundary before Modal scan conversion. |
| Root Python scripts | Local conversion, segmentation, registration, biomarkers, preview generation, and Modal entrypoint. |
| `tests/` | Python, Node, and Playwright checks. |
| `data/` | Bundled demo manifest, PNG stacks, and neutral sidecars. |

### Python type checking

Static analysis uses **basedpyright** (Pyright-compatible). Configuration lives in `pyproject.toml` under `[tool.pyright]`. `npm run setup` installs the dev extra (`pip install -e ".[dev]"`), which includes basedpyright alongside pytest.

- Run **`npm run check:py:types`** for the type checker alone, or **`npm run check:py`** for `py_compile` plus types (same as the full `npm run check` Python gate).
- The repo now uses a **standard** global `basedpyright` baseline plus full-tree `reportUnusedCallResult`, `reportImplicitStringConcatenation`, and `reportRedeclaration` checks.
- A smaller strict subset still exists for `scripts/check_ai_ready.py`, `scripts/check_assets.py`, `scripts/check_env.py`, `scripts/check_pipeline_ready.py`, and `scripts/check_validation_matrix.py`.
- Further tightening should promote more files into that strict subset or remove remaining relaxed `report*` overrides deliberately, not by calling the repo "fully strict" before it is.

### Important Modules

| Module | What |
|---|---|
| `js/slice-view.js` | 2D slice rendering, display labels, hover readout |
| `js/mpr-view.js` | Axial/coronal/sagittal/oblique MPR drawing |
| `js/volume-3d.js` | 3D volume rendering orchestration |
| `js/geometry.js` | Canonical browser geometry math, compare grouping, and affine construction |
| `js/volume-raycast-shaders.js` | GLSL raymarching shaders |
| `js/wire-controls.js` | DOM event binding |
| `js/select-series.js` | Series switching |
| `js/series-capabilities.js` | MPR/3D gating for true volume stacks vs projection images |
| `js/series-image-stack.js` | Local, in-memory, and R2-backed image URL resolution |
| `geometry.py` | Canonical Python geometry math for conversion, metadata, and pipeline paths |
| `js/view-modes.js` | 2D, MPR, 3D, compare, and dual mode state |
| `js/overlay-stack.js` | Lazy overlay image loading |
| `js/compare.js` | Side-by-side comparison |
| `js/dicom-import.js` | Browser-side DICOM/NIfTI parsing |
| `js/dicomweb/dicomweb-source.js` | DICOMweb metadata/frame adapters that normalize into the same import contract |
| `js/cloud.js` | Modal GPU upload and processing flow |
| `js/config.js` | Runtime config from `config.json` plus local/deploy overlays |
| `js/plugin.js` | Small extension API for panels and lifecycle hooks |

## Change the Viewer

For a new UI tool:

1. Put isolated logic in `js/my-tool.js`.
2. Export an `init` function that accepts dependencies from `viewer.js`.
3. Add UI in `index.html`.
4. Wire events in `js/wire-controls.js`.
5. Add focused Node or Playwright coverage when behavior changes.

For a new data pipeline:

1. Create `my_pipeline.py`.
2. Write output to `data/<slug>_<type>/` plus `data/<slug>_<type>.json` metadata.
3. Add or update the matching `data/manifest.json` entry.
4. Run `npm run check:data`.

For a new modality or import path:

1. Normalize metadata into the shared geometry contract first.
2. Reuse `js/geometry.js` and `geometry.py` instead of adding parallel slice-ordering or affine math.
3. Route WADO-RS metadata and multi-frame payloads through the same source/frame expansion path instead of creating a second import capability tree.
4. Mark unsupported classes `2d-only` or fail closed until voxel geometry is proven.
5. Update public capability docs in `README.md` and `ARCHITECTURE.md` when the boundary changes.

Derived-object imports should stay session-backed unless you are also adding a persisted manifest contract. SEG should keep using the existing region-overlay slot, RTSTRUCT should reuse ROI primitives where possible, SR import should degrade into safe notes if full spatial semantics are unavailable, and RT Dose should stay metadata-only until an actual dose-grid renderer exists.

The upload modal now exposes a DICOMweb entry path. Keep it thin: collect connection details there, but push all real parsing and capability decisions back into the shared import modules.

## Adding a New Overlay Type

Use the same end-to-end path whether the overlay comes from a local Python script or the optional cloud pipeline.

1. Emit the overlay assets in Python.
   Write PNG slices under `data/<slug>_<overlay>/` and a sidecar JSON if the browser needs metadata such as colors, legends, or thresholds.
2. Add manifest fields.
   Extend the series entry with a boolean capability flag such as `hasPerfusion`, plus URL fields when the asset can live on R2 instead of `./data`.
3. Teach the browser loader how to find it.
   Extend `js/series-image-stack.js` if the overlay needs a dedicated URL base or metadata sidecar resolver.
4. Load it during series selection.
   In `js/select-series.js`, request the image stack or sidecar when the series flag is present and the overlay toggle is enabled.
5. Render it in one renderer first.
   Add the pixel blend in `js/slice-view.js` for 2D or `js/mpr-view.js` / `js/volume-label-overlay.js` if it belongs in MPR or 3D too.
6. Add a control and state field.
   Wire the toggle in `js/wire-controls.js` and keep ownership in `js/state.js` under `overlays.*`.
7. Test the contract.
   Add a Node test for URL resolution or blending logic, and a Playwright path if the overlay changes user-visible viewer behavior.

Example path:

- Python pipeline writes `data/<slug>_perfusion/0000.png` plus `data/<slug>_perfusion.json`.
- `manifest.json` gains `"hasPerfusion": true` and optionally `"overlayUrlBases": { "<slug>_perfusion": "https://..." }`.
- `js/select-series.js` loads that stack when `state.usePerfusion` is on.
- `js/slice-view.js` blends the overlay after base window/level and before plugin overlays.

## Pull requests

- Run **`npm run check`** (or at least the subset relevant to your change) before opening a PR when possible; CI runs the same gate.
- Prefer **small, focused PRs**. Large features or refactors should start with an issue so geometry, manifest, and capability boundaries stay coherent.
- When maintainers use GitHub labels, **`good first issue`** is a good entry point for bounded tasks.

## Code Style

- ES modules, no bundler, no transpiler.
- `const` by default, `let` only when mutation is needed.
- Prefer dependency injection from `viewer.js` over circular imports.
- Do not add a second geometry system. Import, compare, MPR, measurement, export, and pipeline code must share the same patient-space rules.
- Use `escapeHtml()` for dynamic content that reaches `innerHTML`.
- Keep AI and measurement outputs labeled as research-only, not diagnostic.
- Keep public config safe. Do not commit real Modal, R2, Vercel, or local machine values.
- Unsupported imaging inputs should fail closed, not silently downgrade into misleading 3D behavior.

## Checks

```bash
npm run check           # JS, Python, data, Node, and browser smoke checks
npm run check:js        # ESLint + JS syntax
npm run check:data      # manifest/config/asset contract checks
npm run check:geometry  # browser/Python geometry parity and fail-closed capability checks
npm run test:node       # Node contract tests
npm run test:python     # pytest contract tests
npm run test:browser    # Playwright viewer smoke tests, including 3D paint
npm run ai:doctor       # local AI provider readiness check
npm run ai:refresh -- --provider claude # regenerate context + analysis + consult
npm run demo:install -- --demo lite     # install the shipped public demo pack
```

Use the support table in `README.md` to decide which checks matter for a claim change. `npm run check` is still the default repo gate; in the full working repo, the validation ledger adds the deeper claim-specific proof commands.

`npm run check` is the default local/CI path. It does not upload to R2, run Modal GPU jobs, call AI providers, or require full compressed-volume release assets.

Before a release that changes local data assets:

```bash
npm run check:data:full
```

Before long CT/SynthSeg runs, check the toolchain you plan to use:

```bash
PYTHON=/tmp/tsenv/bin/python3 PATH="/tmp/tsenv/bin:$PATH" MRI_VIEWER_DICOM_ROOT=/path/to/dicom npm run check:pipeline -- --no-synthseg
PYTHON=/tmp/synthseg_env/bin/python MRI_VIEWER_DICOM_ROOT=/path/to/dicom npm run check:pipeline -- --no-ct
npm run check:pipeline -- --projection-source /path/to/projections --ultrasound-source /path/to/ultrasound
```

SynthSeg is an optional external integration in the OSS repo. The supported runtime shapes are:
- local FreeSurfer `mri_synthseg`
- upstream SynthSeg cloned into a local `synthseg_repo/` checkout with a local venv

## Cloud Processing

Cloud processing is optional. The browser and `scripts/submit_modal_study.py` use the same flow: ask Modal for presigned R2 PUT URLs, upload files directly to R2, start processing, poll status, then consume the returned `series.json`.

```bash
npm run setup -- --cloud
npm run check:cloud
npm run modal:submit -- /path/to/dicoms --job-id my_job_001 --modality auto
node scripts/run_python.mjs scripts/merge_modal_result.py --r2-public-url "$R2_PUBLIC_URL" --job-id my_job_001
```

Create a local `.env` for private values such as `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`, `MODAL_WEBHOOK_BASE`, and `MODAL_AUTH_TOKEN`. Do not commit it.

Calibrated projection reconstruction and calibrated ultrasound scan conversion both require an explicit `voxellab.source.json` sidecar in the uploaded folder. The browser preserves that calibration summary, but the actual reconstruction runs in the Modal/Python engine path. The preferred RTK runtime is the bundled `scripts/rtk_projection_wrapper.py` wrapper on top of `itk-rtk`, installed via `npm run setup -- --pipeline --rtk`. `MRI_VIEWER_RTK_COMMAND` still overrides that default when you need a different RTK wrapper:

```bash
npm run modal:submit -- /path/to/projections --job-id projection_job_001 --modality auto --processing-mode projection_set_reconstruction --input-kind calibrated_projection_set
npm run modal:submit -- /path/to/ultrasound --job-id ultrasound_job_001 --modality auto --processing-mode ultrasound_scan_conversion --input-kind calibrated_ultrasound_source
```

Those submitter paths now run the same source-manifest and runtime preflight locally before upload, so OSS users get an immediate error for missing calibration or missing RTK runtime.

## Public Release Notes

The working repo may contain private planning docs, local env files, generated data, and rich development history. The public repo is a sanitized export.

- Public `main` is intentionally a clean rolling snapshot. Audit-friendly public checkpoints should come from tagged `v*` releases, which can rerun the same check gate before publishing release notes.
- `npm run sync:public` is a **working-repo maintainer command**. The sanitized public export removes that script on purpose, so outside contributors should not expect it to exist there.
- If you are working in the maintainer repo, use the configured public-export workspace in your local release workflow:

```bash
npm run sync:public
```

The sync script removes private/local-only files, keeps `config.json` public-safe, keeps the public `demo_packs/` installer assets, and resets `data/manifest.json` to the empty state so first-run users install approved public demos explicitly.

## Medical Accuracy

- Never claim diagnostic capability.
- All AI outputs must include "Not for clinical diagnosis" or equivalent research-only wording.
- Coordinate math must follow DICOM LPS convention.
- `PixelSpacing[0]` is row spacing and `PixelSpacing[1]` is column spacing.

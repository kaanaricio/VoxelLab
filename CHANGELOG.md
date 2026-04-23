# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) where versioning applies to packaged releases.

## Unreleased

Local signed 16-bit DICOM imports now preserve negative voxel values when `BitsStored` matches `BitsAllocated`, so CT series with signed pixel data keep correct Hounsfield scaling in 2D, MPR, and 3D instead of wrapping into large positive intensities.

Cloud calibrated reconstruction results now round-trip through the manifest contract correctly: uploaded `voxellab.source.json` files are signed and sent as `application/json`, reconstructed projection outputs are emitted in the `projectionSets[]` shape the client and validator accept, and derived reconstructions no longer overwrite their 2D source series just because they share a `sourceSeriesUID`.

The local browser config no longer exposes `localApiToken` through `/config.json`; same-origin pages fetch it from a dedicated local endpoint instead, which closes the broad localhost cross-origin read path while preserving the local proxy flow.

The click-to-segment tool has been renamed from MedSAM to SlimSAM across the viewer surface, with the SlimSAM overlay controls now honoring their configured mask color and opacity.

## [2026-04-12]

### Added

- Community documentation: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, and this `CHANGELOG.md` for contributor expectations.
- README: project table linking license, contributing, security, changelog, architecture, CI, and default privacy stance; CI and license badges; public non-goals summary (detailed roadmap in internal `docs/roadmap.md`).
- CONTRIBUTING: conduct/security pointers, pull-request expectations, and `good first issue` note.

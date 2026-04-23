# Security Policy

## Supported versions

Security fixes are applied to the **default development branch** (`main` / `master`) of this repository. Tagged releases follow that branch when present. Older snapshots are best-effort only.

## Reporting a vulnerability

**Please do not** file public GitHub issues for undisclosed security vulnerabilities (they would disclose the issue to everyone).

**Preferred:** use [GitHub **private security advisories**](https://github.com/kaanaricio/VoxelLab/security/advisories) for this repository if that feature is enabled.

If advisories are unavailable, contact the maintainers in a **private** way (for example, enable “Report a vulnerability” on the repo if offered, or email a maintainer if one is published on their GitHub profile). Include enough detail to reproduce or assess impact.

## Scope

This policy covers **this software repository** (viewer, scripts, and documented workflows). It does **not** replace your institution’s policies for **clinical data**, **patient safety**, or **regulated systems**. VoxelLab is [not intended for clinical use](README.md); treat imaging data according to your local rules.

## What to include

- Affected component (e.g. `serve.py`, `modal_app.py`, browser upload path)
- Steps to reproduce or a clear description of the flaw
- Impact assessment if you can (confidentiality, integrity, availability)

We aim to acknowledge reports within a few business days and coordinate disclosure after a fix.

## Safe harbor

We support good-faith research and coordinated disclosure. Do not test against systems or data you do not own or lack permission to test.

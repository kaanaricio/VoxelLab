"""
Modal cloud pipeline entrypoint.

This module now stays narrow on purpose:
  - Modal app + resource config
  - `process_study()` orchestration
  - decorated webhook exports
  - compatibility re-exports for tests / callers
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import modal

from engine_sources import (
    load_source_manifest,
    normalize_source_manifest,
    projection_summary,
    ultrasound_summary,
)
from geometry import geometry_from_slices
from modal_dicom import (
    PROJECTION_IMAGE_MARKERS,
    PROJECTION_MODALITIES,
    dicom_group_key,
    ensure_projection_inputs,
    ensure_ultrasound_inputs,
    expand_primary_stack,
    is_projection_like_dicom,
    mpr_geometry_error,
    select_primary_dicom_stack,
    select_primary_dicom_stack_details,
    stack_pixels_with_rescale,
)
from modal_io import (
    compress_raw_volume,
    download_r2_objects,
    get_r2_client,
    iter_r2_object_keys,
    upload_r2_files,
)
from modal_regions import (
    combine_totalseg_outputs,
    golden_color,
    humanize_region_name,
    write_region_outputs,
)
from modal_validation import (
    MODALITIES,
    UPLOAD_ID_RE,
    JOB_ID_RE,
    auth_error,
    drop_none,
    env_float,
    env_gpu,
    env_int,
    normalize_upload_items,
    retry_policy,
    upload_object_name,
    validate_input_kind,
    validate_job_id,
    validate_modality,
    validate_processing_mode,
    validate_upload_filename,
    validate_upload_id,
)
from modal_volumes import (
    build_projection_set_entry,
    build_derived_volume_entry,
    normalize_volume_for_pngs,
    normalize_volume_for_raw,
    source_uid_value,
    write_nifti_from_dicom_stack,
    write_png_stack,
    write_volume_outputs,
)
from modal_webhooks import (
    check_status as _check_status,
    configure_webhooks,
    get_upload_urls as _get_upload_urls,
    start_processing as _start_processing,
)
from projection_reconstruction import reconstruct_projection_volume
from series_contract import normalize_series_entry
from ultrasound_reconstruction import reconstruct_ultrasound_volume

app = modal.App("medical-imaging-pipeline")

CT_ROI_SUBSET = [
    "lung_upper_lobe_left", "lung_lower_lobe_left",
    "lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right",
    "heart", "aorta", "inferior_vena_cava", "pulmonary_vein",
    "trachea", "esophagus", "liver", "spleen", "stomach",
    "kidney_left", "kidney_right", "vertebrae_T1", "vertebrae_T2",
    "vertebrae_T3", "vertebrae_T4", "vertebrae_T5", "vertebrae_T6",
    "vertebrae_T7", "vertebrae_T8", "vertebrae_T9", "vertebrae_T10",
    "vertebrae_T11", "vertebrae_T12", "rib_left_1", "rib_right_1",
    "rib_left_2", "rib_right_2", "rib_left_3", "rib_right_3",
]

pipeline_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("zstd")
    .pip_install(
        "numpy", "scipy", "scikit-learn", "Pillow",
        "pydicom", "nibabel",
        "torch", "torchvision",
        "boto3",
    )
    .pip_install("totalsegmentator")
    .pip_install("hd-bet")
)

BUCKET = os.environ.get("R2_BUCKET", "scan-data")
R2_SECRET = modal.Secret.from_name(os.environ.get("MRI_VIEWER_MODAL_R2_SECRET", "r2-creds"))
MODAL_AUTH_TOKEN = os.environ.get("MODAL_AUTH_TOKEN", "").strip()
R2_TRANSFER_WORKERS = env_int("MRI_VIEWER_R2_TRANSFER_WORKERS", 8, min_value=1, max_value=64)

PROCESS_FUNCTION_CONFIG = drop_none(
    image=pipeline_image,
    gpu=env_gpu("MRI_VIEWER_MODAL_GPU", "T4"),
    cpu=env_float("MRI_VIEWER_MODAL_CPU", 4.0, min_value=0.125),
    memory=env_int("MRI_VIEWER_MODAL_MEMORY_MB", 16384, min_value=512),
    ephemeral_disk=env_int("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", 200 * 1024, min_value=512),
    timeout=env_int("MRI_VIEWER_MODAL_TIMEOUT_SECONDS", 3600, min_value=60, max_value=24 * 60 * 60),
    startup_timeout=env_int("MRI_VIEWER_MODAL_STARTUP_TIMEOUT_SECONDS", 900, min_value=60, max_value=3600),
    retries=retry_policy(
        env_int("MRI_VIEWER_MODAL_RETRIES", 1, min_value=0, max_value=5),
        env_float("MRI_VIEWER_MODAL_RETRY_INITIAL_DELAY_SECONDS", 5.0, min_value=0.0),
        env_float("MRI_VIEWER_MODAL_RETRY_BACKOFF", 2.0, min_value=1.0),
    ),
    secrets=[R2_SECRET],
    max_containers=env_int("MRI_VIEWER_MODAL_MAX_CONTAINERS", 10, min_value=1),
    min_containers=env_int("MRI_VIEWER_MODAL_MIN_CONTAINERS", 0, min_value=0),
    buffer_containers=env_int("MRI_VIEWER_MODAL_BUFFER_CONTAINERS", 0, min_value=0),
    scaledown_window=env_int("MRI_VIEWER_MODAL_SCALEDOWN_WINDOW_SECONDS", 300, min_value=2, max_value=20 * 60),
)

WEB_FUNCTION_CONFIG = drop_none(
    image=modal.Image.debian_slim(python_version="3.11").pip_install("boto3", "fastapi[standard]"),
    cpu=env_float("MRI_VIEWER_MODAL_WEB_CPU", 0.5, min_value=0.125),
    memory=env_int("MRI_VIEWER_MODAL_WEB_MEMORY_MB", 512, min_value=128),
    timeout=env_int("MRI_VIEWER_MODAL_WEB_TIMEOUT_SECONDS", 120, min_value=1, max_value=150),
    retries=retry_policy(
        env_int("MRI_VIEWER_MODAL_WEB_RETRIES", 0, min_value=0, max_value=5),
        env_float("MRI_VIEWER_MODAL_WEB_RETRY_INITIAL_DELAY_SECONDS", 1.0, min_value=0.0),
        env_float("MRI_VIEWER_MODAL_WEB_RETRY_BACKOFF", 2.0, min_value=1.0),
    ),
    secrets=[R2_SECRET],
    max_containers=env_int("MRI_VIEWER_MODAL_WEB_MAX_CONTAINERS", 20, min_value=1),
    min_containers=env_int("MRI_VIEWER_MODAL_WEB_MIN_CONTAINERS", 0, min_value=0),
    buffer_containers=env_int("MRI_VIEWER_MODAL_WEB_BUFFER_CONTAINERS", 0, min_value=0),
    scaledown_window=env_int("MRI_VIEWER_MODAL_WEB_SCALEDOWN_WINDOW_SECONDS", 300, min_value=2, max_value=20 * 60),
)


@app.function(**PROCESS_FUNCTION_CONFIG)
def process_study(
    job_id: str,
    modality: str = "auto",
    processing_mode: str = "standard",
    input_kind: str = "dicom_volume_stack",
) -> dict:
    """Thin orchestrator for the Modal study pipeline."""
    job_id = validate_job_id(job_id)
    modality = validate_modality(modality)
    processing_mode = validate_processing_mode(processing_mode)
    input_kind = validate_input_kind(input_kind, processing_mode)
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if not modality:
        return {"status": "error", "error": "invalid modality"}
    if not processing_mode:
        return {"status": "error", "error": "invalid processing_mode"}
    if not input_kind:
        return {"status": "error", "error": "invalid input_kind"}

    import numpy as np
    import pydicom
    from PIL import Image
    from scipy import ndimage

    s3 = get_r2_client()
    work_dir = Path(tempfile.mkdtemp())
    output_root = work_dir / "output"

    try:
        print(f"[{job_id}] downloading DICOMs from R2...", flush=True)
        dcm_dir = work_dir / "dicoms"
        dcm_dir.mkdir()
        n_files = download_r2_objects(s3, BUCKET, f"uploads/{job_id}/", dcm_dir, R2_TRANSFER_WORKERS)
        print(f"[{job_id}] downloaded {n_files} files", flush=True)
        if n_files == 0:
            return {"status": "error", "error": "no DICOM files found"}

        source_manifest = normalize_source_manifest(load_source_manifest(dcm_dir))
        datasets = []
        for path in sorted(dcm_dir.iterdir()):
            if not path.is_file():
                continue
            try:
                ds = pydicom.dcmread(path, force=True)
                if hasattr(ds, "PixelData"):
                    datasets.append(ds)
            except Exception:
                continue
        if not datasets:
            return {"status": "error", "error": "no valid DICOM slices found"}

        public_url = os.environ.get("R2_PUBLIC_URL", "").rstrip("/")

        if processing_mode == "projection_set_reconstruction":
            if input_kind != "calibrated_projection_set":
                return {"status": "error", "error": "projection reconstruction requires calibrated_projection_set input_kind"}
            selected, error = ensure_projection_inputs(datasets, source_manifest)
            if error:
                return {"status": "error", "error": error}

            reconstructed = reconstruct_projection_volume(selected, source_manifest, np)
            vol = reconstructed["volume"]
            slug = f"cloud_proj_{job_id[:8]}"
            depth, height, width = vol.shape
            out_dir, zst_path = write_volume_outputs(
                vol=vol,
                slug=slug,
                modality="CT",
                out_root=output_root,
                public_url=public_url,
                Image=Image,
                np=np,
            )
            projection_set = reconstructed["projectionSet"]
            # Shape: {"status":"calibrated","angleCount":120,...}.
            projection_calibration = projection_summary(source_manifest)

            uploads = [(png, f"data/{slug}/{png.name}", "image/png") for png in sorted(out_dir.glob("*.png"))]
            uploads.append((zst_path, f"{slug}.raw.zst", "application/zstd"))
            upload_r2_files(s3, BUCKET, uploads, R2_TRANSFER_WORKERS)

            projection_entry = build_projection_set_entry(
                projection_set,
                modality=str(getattr(selected[0], "Modality", "") or "XA"),
                source_series_slug=projection_set["id"],
                projection_calibration=projection_calibration,
                engine_report=reconstructed.get("report", {}),
            )
            entry = build_derived_volume_entry(
                slug=slug,
                name=str(source_manifest.get("name", "") or "Projection reconstruction"),
                description=f"{depth} slices · {width}×{height} · calibrated projection reconstruction",
                modality="CT",
                width=width,
                height=height,
                depth=depth,
                geometry=reconstructed["geometry"],
                public_url=public_url,
                source_projection_set_id=projection_set["id"],
                source_series_uid=projection_set.get("sourceSeriesUID", ""),
                frame_of_reference_uid=reconstructed["geometry"].get("frameOfReferenceUID", ""),
                engine_source_kind="projection-reconstruction",
                engine_report=reconstructed.get("report", {}),
            )
            s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/series.json", Body=json.dumps(entry, indent=2), ContentType="application/json")
            s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/projection_set.json", Body=json.dumps(projection_entry, indent=2), ContentType="application/json")
            s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/status.json", Body=json.dumps({"status": "complete", "slug": slug}), ContentType="application/json")
            return {"status": "complete", "slug": slug, "series_entry": entry, "projection_set_entry": projection_entry}

        if processing_mode == "ultrasound_scan_conversion":
            if input_kind != "calibrated_ultrasound_source":
                return {"status": "error", "error": "ultrasound reconstruction requires calibrated_ultrasound_source input_kind"}
            selected, error = ensure_ultrasound_inputs(datasets, source_manifest, np)
            if error:
                return {"status": "error", "error": error}

            reconstructed = reconstruct_ultrasound_volume(selected, source_manifest, np, ndimage)
            vol = reconstructed["volume"]
            slug = f"cloud_us_{job_id[:8]}"
            depth, height, width = vol.shape
            out_dir, zst_path = write_volume_outputs(
                vol=vol,
                slug=slug,
                modality="US",
                out_root=output_root,
                public_url=public_url,
                Image=Image,
                np=np,
            )
            uploads = [(png, f"data/{slug}/{png.name}", "image/png") for png in sorted(out_dir.glob("*.png"))]
            uploads.append((zst_path, f"{slug}.raw.zst", "application/zstd"))
            upload_r2_files(s3, BUCKET, uploads, R2_TRANSFER_WORKERS)

            entry = build_derived_volume_entry(
                slug=slug,
                name=str(source_manifest.get("name", "") or "Ultrasound reconstruction"),
                description=f"{depth} slices · {width}×{height} · calibrated ultrasound reconstruction",
                modality="US",
                width=width,
                height=height,
                depth=depth,
                geometry=reconstructed["geometry"],
                public_url=public_url,
                source_series_uid=source_uid_value(source_manifest, "seriesUID"),
                frame_of_reference_uid=reconstructed["geometry"].get("frameOfReferenceUID", ""),
                body_part=str(source_manifest.get("bodyPart", "") or ""),
                engine_source_kind="ultrasound-scan-conversion",
                engine_report=reconstructed.get("report", {}),
            )
            entry["ultrasoundCalibration"] = ultrasound_summary(source_manifest)
            s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/series.json", Body=json.dumps(entry, indent=2), ContentType="application/json")
            s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/status.json", Body=json.dumps({"status": "complete", "slug": slug}), ContentType="application/json")
            return {"status": "complete", "slug": slug, "series_entry": entry}

        requested_modality = modality
        slices, selected_modality, selected_key, dropped_series = select_primary_dicom_stack_details(datasets, requested_modality)
        if not slices:
            detected = sorted({str(getattr(ds, "Modality", "") or "unknown") for ds in datasets})
            return {"status": "error", "error": f"unsupported modality/series: {detected}"}
        slices, error = expand_primary_stack(slices)
        if error:
            return {"status": "error", "error": error}
        modality = selected_modality
        print(f"[{job_id}] selected {len(slices)}/{len(datasets)} slices, modality={modality}, shape={selected_key[3]}x{selected_key[2]}", flush=True)

        geometry_error = mpr_geometry_error(slices)
        if geometry_error:
            return {"status": "error", "error": geometry_error}

        first = slices[0]
        width = int(first.Columns)
        height = int(first.Rows)
        depth = len(slices)
        slug = f"cloud_{job_id[:8]}"
        geometry = geometry_from_slices(slices)
        pixel_spacing = geometry["pixelSpacing"]
        thickness = float(geometry["sliceThickness"])

        vol = stack_pixels_with_rescale(slices)

        out_dir, zst_path = write_volume_outputs(
            vol=vol,
            slug=slug,
            modality=modality,
            out_root=output_root,
            public_url=public_url,
            Image=Image,
            np=np,
        )
        print(f"[{job_id}] wrote {depth} PNGs", flush=True)
        print(f"[{job_id}] compressed {zst_path.name}", flush=True)

        region_dir = None
        region_sidecar = None
        if modality == "CT":
            try:
                import nibabel as nib

                nii_path = work_dir / f"{slug}.nii.gz"
                write_nifti_from_dicom_stack(vol, slices, nii_path, np, nib)
                ts_out = work_dir / "ts_out"
                result = subprocess.run(
                    ["TotalSegmentator", "-i", str(nii_path), "-o", str(ts_out), "--task", "total", "--fast", "--roi_subset", *CT_ROI_SUBSET],
                    capture_output=True,
                    text=True,
                    timeout=1800,
                )
                if result.returncode == 0:
                    label_vol, legend = combine_totalseg_outputs(ts_out, (depth, height, width), nii_path, np, nib)
                    if legend:
                        region_dir, region_sidecar = write_region_outputs(
                            slug,
                            label_vol,
                            legend,
                            output_root,
                            pixel_spacing,
                            thickness,
                            Image,
                            np,
                        )
                        print(f"[{job_id}] TotalSegmentator OK ({len(legend)} labels)", flush=True)
                    else:
                        print(f"[{job_id}] TotalSegmentator produced no labels", flush=True)
                else:
                    print(f"[{job_id}] TotalSegmentator failed: {result.stderr[-500:]}", flush=True)
            except Exception as exc:
                print(f"[{job_id}] TotalSegmentator error: {exc}", flush=True)

        uploads = [(png, f"data/{slug}/{png.name}", "image/png") for png in sorted(out_dir.glob("*.png"))]
        if region_dir and region_sidecar:
            uploads.extend((png, f"data/{region_dir.name}/{png.name}", "image/png") for png in sorted(region_dir.glob("*.png")))
            uploads.append((region_sidecar, f"data/{region_sidecar.name}", "application/json"))
        uploads.append((zst_path, f"{slug}.raw.zst", "application/zstd"))
        upload_r2_files(s3, BUCKET, uploads, R2_TRANSFER_WORKERS)

        series_desc = str(getattr(first, "SeriesDescription", "") or "").strip()
        entry: dict[str, Any] = {
            "slug": slug,
            "name": series_desc or f"Cloud {modality} {job_id[:8]}",
            "description": f"{depth} slices · {width}×{height} · cloud processed",
            "modality": modality,
            "slices": depth,
            "width": width,
            "height": height,
            "pixelSpacing": pixel_spacing,
            "sliceThickness": thickness,
            "sliceSpacing": float(geometry["sliceSpacing"]),
            "sliceSpacingRegular": bool(geometry["sliceSpacingRegular"]),
            "tr": float(getattr(first, "RepetitionTime", 0) or 0),
            "te": float(getattr(first, "EchoTime", 0) or 0),
            "sequence": series_desc or modality,
            "firstIPP": geometry["firstIPP"],
            "lastIPP": geometry["lastIPP"],
            "orientation": geometry["orientation"],
            "group": None,
            "hasBrain": False,
            "hasSeg": False,
            "hasSym": False,
            "hasRegions": bool(region_dir and region_sidecar),
            "hasStats": False,
            "hasAnalysis": False,
            "hasMaskRaw": False,
            "hasRaw": True,
            "geometryKind": "volumeStack",
            "reconstructionCapability": "display-volume",
            "renderability": "volume",
        }
        if region_dir and region_sidecar:
            entry["anatomySource"] = "totalseg"
        for field, attr in (
            ("sourceStudyUID", "StudyInstanceUID"),
            ("sourceSeriesUID", "SeriesInstanceUID"),
            ("frameOfReferenceUID", "FrameOfReferenceUID"),
            ("bodyPart", "BodyPartExamined"),
        ):
            value = str(getattr(first, attr, "") or "")
            if value:
                entry[field] = value
        entry = normalize_series_entry(
            entry,
            public_url,
            region_dir_name=region_dir.name if region_dir else "",
            region_meta_name=region_sidecar.name if region_sidecar else "",
        )
        if dropped_series:
            entry["droppedSeries"] = dropped_series

        s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/series.json", Body=json.dumps(entry, indent=2), ContentType="application/json")
        status_payload = {"status": "complete", "slug": slug}
        if dropped_series:
            status_payload["droppedSeries"] = dropped_series
        s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/status.json", Body=json.dumps(status_payload), ContentType="application/json")
        print(f"[{job_id}] done! slug={slug}", flush=True)
        return {"status": "complete", "slug": slug, "series_entry": entry, **({"droppedSeries": dropped_series} if dropped_series else {})}

    except Exception as exc:
        error = str(exc)
        print(f"[{job_id}] ERROR: {error}", flush=True)
        try:
            s3.put_object(Bucket=BUCKET, Key=f"results/{job_id}/status.json", Body=json.dumps({"status": "error", "error": error}), ContentType="application/json")
        except Exception:
            pass
        return {"status": "error", "error": error}
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


configure_webhooks(
    bucket=BUCKET,
    get_r2_client=get_r2_client,
    process_study=process_study,
    upload_expiry_seconds=env_int("MRI_VIEWER_MODAL_UPLOAD_EXPIRY_SECONDS", 900, min_value=60, max_value=900),
    max_upload_bytes=env_int("MRI_VIEWER_MODAL_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024, min_value=1),
)

start_processing = app.function(**WEB_FUNCTION_CONFIG)(modal.fastapi_endpoint(method="POST")(_start_processing))
check_status = app.function(**WEB_FUNCTION_CONFIG)(modal.fastapi_endpoint(method="POST")(_check_status))
get_upload_urls = app.function(**WEB_FUNCTION_CONFIG)(modal.fastapi_endpoint(method="POST")(_get_upload_urls))


def main() -> bool:
    print(
        "This file defines a Modal app. Typical commands:\n"
        + "  modal deploy modal_app.py\n"
        + "  modal run modal_app.py\n",
        file=sys.stderr,
    )
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)

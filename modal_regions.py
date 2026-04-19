from __future__ import annotations

import colorsys
import json
from pathlib import Path


def humanize_region_name(name: str) -> str:
    return name.replace("_", " ").capitalize()


def golden_color(i: int) -> list[int]:
    h = (i * 0.6180339887) % 1.0
    s = 0.40 + 0.10 * ((i * 0.37) % 1.0)
    v = 0.62 + 0.16 * ((i * 0.71) % 1.0)
    r, g, b = colorsys.hsv_to_rgb(h, s, v)
    return [int(round(r * 255)), int(round(g * 255)), int(round(b * 255))]


def combine_totalseg_outputs(ts_dir: Path, target_shape_dhw: tuple[int, int, int], reference_nii_path: Path, np, nib):
    from nibabel.orientations import apply_orientation, io_orientation, ornt_transform
    from scipy import ndimage

    nii_files = sorted(ts_dir.glob("*.nii.gz"))
    label_vol = np.zeros(target_shape_dhw, dtype=np.uint16)
    legend: dict[int, str] = {}
    if not nii_files:
        return label_vol.astype(np.uint8), legend

    ref_img = nib.load(str(reference_nii_path))
    ref_ornt = io_orientation(ref_img.affine)
    next_id = 1
    for nii_path in nii_files:
        name = nii_path.name.replace(".nii.gz", "")
        mask_img = nib.load(str(nii_path))
        mask_data = np.asarray(mask_img.dataobj)
        transform = ornt_transform(io_orientation(mask_img.affine), ref_ornt)
        mask_data = apply_orientation(mask_data, transform)
        mask_dhw = np.transpose(mask_data, (2, 1, 0))
        if mask_dhw.shape != target_shape_dhw:
          zoom = (
              target_shape_dhw[0] / mask_dhw.shape[0],
              target_shape_dhw[1] / mask_dhw.shape[1],
              target_shape_dhw[2] / mask_dhw.shape[2],
          )
          mask_dhw = ndimage.zoom(mask_dhw, zoom, order=0)
        positive = mask_dhw > 0
        if positive.sum() == 0:
            continue
        legend[next_id] = name
        label_vol[positive] = next_id
        next_id += 1
    return label_vol.astype(np.uint8) if next_id < 256 else label_vol, legend


def write_region_outputs(slug: str, label_vol, legend: dict[int, str], out_root: Path, pixel_spacing: list[float], slice_thickness: float, Image, np) -> tuple[Path, Path]:
    region_dir = out_root / f"{slug}_regions"
    region_dir.mkdir(parents=True, exist_ok=True)
    for z in range(label_vol.shape[0]):
        Image.fromarray(label_vol[z].astype(np.uint8), mode="L").save(region_dir / f"{z:04d}.png")

    colors = {str(k): golden_color(k) for k in legend}
    voxel_ml = (pixel_spacing[0] * pixel_spacing[1] * slice_thickness) / 1000.0
    regions = {}
    for rid, name in legend.items():
        count = int((label_vol == rid).sum())
        regions[str(rid)] = {
            "name": humanize_region_name(name),
            "color": colors[str(rid)],
            "mL": round(count * voxel_ml, 1),
            "voxels": count,
        }

    sidecar_path = out_root / f"{slug}_regions.json"
    _ = sidecar_path.write_text(json.dumps({
        "legend": {str(k): v for k, v in legend.items()},
        "colors": colors,
        "regions": regions,
    }, indent=2))
    return region_dir, sidecar_path

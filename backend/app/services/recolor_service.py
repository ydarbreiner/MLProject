import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, Tuple

import laspy
import numpy as np
import logging

from app.core.config import settings

logger = logging.getLogger(__name__)


class RecolorError(Exception):
    """Raised when recoloring fails."""


def _hex_to_rgb16(hex_color: str) -> Tuple[int, int, int]:
    """Convert #RRGGBB (or RRGGBB) to 16-bit LAS RGB tuple."""
    trimmed = hex_color.strip()
    if trimmed.startswith("#"):
        trimmed = trimmed[1:]
    if len(trimmed) != 6:
        raise RecolorError(f"Invalid hex color: {hex_color}")
    r = int(trimmed[0:2], 16)
    g = int(trimmed[2:4], 16)
    b = int(trimmed[4:6], 16)
    # LAS stores colors as 16-bit; scale 8-bit values.
    return r * 256, g * 256, b * 256


def _parse_palette(palette: Dict[int, str]) -> Dict[int, np.ndarray]:
    parsed: Dict[int, np.ndarray] = {}
    for cls, color in palette.items():
        cls_id = int(cls)
        parsed[cls_id] = np.array(_hex_to_rgb16(color), dtype=np.uint16)
    return parsed


def recolor_pointcloud_file(pointcloud_id: int, palette: Dict[int, str]) -> Path:
    """
    Recolor per-point RGB for a point cloud by classification and overwrite the COPC file.
    Returns the final COPC path.
    """
    base_dir = Path(settings.pointcloud_output_dir) / str(pointcloud_id)
    src_copc = base_dir / "data.copc.laz"
    if not src_copc.exists():
        raise RecolorError(f"COPC file not found: {src_copc}")

    palette_np = _parse_palette(palette)
    if not palette_np:
        raise RecolorError("Palette is empty; nothing to recolor.")

    base_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"recolor_{pointcloud_id}_"))
    tmp_laz = tmp_dir / "recolored.laz"
    tmp_copc = tmp_dir / "recolored.copc.laz"

    try:
        with laspy.open(src_copc) as reader, laspy.open(tmp_laz, mode="w", header=reader.header) as writer:
            for points in reader.chunk_iterator(500_000):
                cls = points.classification
                r, g, b = points.red, points.green, points.blue
                present = set(cls.tolist())
                if present & palette_np.keys():
                    for code, rgb16 in palette_np.items():
                        mask = cls == code
                        if not mask.any():
                            continue
                        r[mask] = rgb16[0]
                        g[mask] = rgb16[1]
                        b[mask] = rgb16[2]
                    points.red = r
                    points.green = g
                    points.blue = b
                writer.write_points(points)

        # Convert to COPC (requires PDAL)
        pdal_path = shutil.which("pdal") or "/opt/conda/bin/pdal"
        if not Path(pdal_path).exists():
            raise RecolorError("PDAL is required to convert recolored LAZ to COPC, but was not found on PATH.")

        translate_cmd = [
            pdal_path,
            "translate",
            str(tmp_laz),
            str(tmp_copc),
            "copc",
        ]
        result = subprocess.run(translate_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            logger.error("PDAL translate failed: %s", result.stderr or result.stdout)
            raise RecolorError(f"PDAL translate failed: {result.stderr or result.stdout}")

        # Backup original and replace
        backup = src_copc.with_suffix(".bak")
        if src_copc.exists():
            shutil.move(src_copc, backup)
        shutil.move(tmp_copc, src_copc)
        return src_copc
    except Exception as exc:  # noqa: BLE001
        raise RecolorError(str(exc)) from exc
    finally:
        # Clean temporary files
        shutil.rmtree(tmp_dir, ignore_errors=True)

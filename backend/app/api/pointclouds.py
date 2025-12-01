import json
import logging
import os
import shutil
import tempfile
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import get_db
from app.models.classification_edit import ClassificationEditBatch, ClassificationEditStatus
from app.models.measurement import Measurement
from app.models.pointcloud import PointCloud, ProcessingStatus
from app.models.project import Project
from app.models.project_file import ProjectFile
from app.models.classification_color_scheme import ClassificationColorScheme
from app.services.classification_edits import enqueue_classification_edit_batch
from app.services.pointcloud_processor import PointCloudProcessor
from app.services.projects import (
    add_file_to_project,
    create_project,
    delete_project,
    delete_project_file,
    get_project,
    get_project_file,
    list_projects,
    update_project,
)
from app.services.recolor_service import recolor_pointcloud_file, RecolorError
from pydantic import BaseModel, Field, ConfigDict, validator, model_validator

try:
    from pyproj import CRS, Transformer  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    CRS = None  # type: ignore[assignment]
    Transformer = None  # type: ignore[assignment]

try:
    from shapely.errors import ShapelyError
    from shapely.geometry import Point as ShapelyPoint
    from shapely.geometry import shape as shapely_shape
except ImportError:  # pragma: no cover - optional dependency
    ShapelyPoint = None  # type: ignore[assignment]
    shapely_shape = None  # type: ignore[assignment]
    class ShapelyError(Exception):  # type: ignore[no-redef]
        pass

router = APIRouter()
logger = logging.getLogger(__name__)


class ClassificationEditPointPayload(BaseModel):
    tile_key: str = Field(..., alias="tileKey")
    point_index: int = Field(..., alias="pointIndex", ge=0)
    source_id: Optional[str] = Field(None, alias="sourceId")
    unstable: Optional[bool] = None


class ClassificationEditOperationPayload(BaseModel):
    new_class: int = Field(..., alias="newClass", ge=0)
    previous_class: Optional[int] = Field(None, alias="previousClass")
    points: List[ClassificationEditPointPayload]
    metadata: Optional[Dict[str, Any]] = None

    @validator("points")
    def validate_points(cls, value: List[ClassificationEditPointPayload]) -> List[ClassificationEditPointPayload]:
        if not value:
            raise ValueError("Each operation must include at least one point.")
        if len(value) > 200_000:
            raise ValueError("Each operation can include at most 200k points.")
        return value


class ClassificationEditRequestPayload(BaseModel):
    operations: List[ClassificationEditOperationPayload]
    client_timestamp: Optional[datetime] = Field(None, alias="clientTimestamp")
    note: Optional[str] = None

    @validator("operations")
    def validate_operations(cls, value: List[ClassificationEditOperationPayload]) -> List[ClassificationEditOperationPayload]:
        if not value:
            raise ValueError("Payload must include at least one operation.")
        if len(value) > 100:
            raise ValueError("Too many operations submitted in a single payload.")
        return value


class ClassificationEditResponsePayload(BaseModel):
    operationId: str
    status: ClassificationEditStatus
    acceptedPoints: int


class ClassificationEditStatusPayload(BaseModel):
    operationId: str
    status: ClassificationEditStatus
    totalPoints: int
    pointsProcessed: int
    tilesTotal: int
    tilesProcessed: int
    unstableCount: int
    receivedAt: datetime
    updatedAt: datetime
    completedAt: Optional[datetime]


class ProjectCreatePayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=2048)
    geometry: Optional[Dict[str, Any]] = None
    centroid: Optional[Dict[str, float]] = None
    metadata: Optional[Dict[str, Any]] = None


class ProjectUpdatePayload(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=2048)
    geometry: Optional[Dict[str, Any]] = None
    centroid: Optional[Dict[str, float]] = None
    metadata: Optional[Dict[str, Any]] = None


class PointCloudUpdatePayload(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    project_id: Optional[int] = Field(None, alias="projectId")

    model_config = ConfigDict(populate_by_name=True)


class PointCloudPolePositionPayload(BaseModel):
    x: float
    y: float
    z: Optional[float] = None


class PointCloudPoleUpdatePayload(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    lat: Optional[float] = None
    lng: Optional[float] = None
    alt: Optional[float] = None
    position: Optional[PointCloudPolePositionPayload] = None

    @model_validator(mode="after")
    def ensure_update_fields(cls, values: "PointCloudPoleUpdatePayload") -> "PointCloudPoleUpdatePayload":
        if not any(
            field is not None
            for field in (values.name, values.lat, values.lng, values.alt, values.position)
        ):
            raise ValueError("Update payload must include at least one field.")
        return values


class MeasurementPointPayload(BaseModel):
    x: float
    y: float
    z: float


class MeasurementCreatePayload(BaseModel):
    point1: MeasurementPointPayload
    point2: MeasurementPointPayload
    distance: float
    label: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class MeasurementUpdatePayload(BaseModel):
    label: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class RecolorRequestPayload(BaseModel):
    palette: Dict[int, str]

    @validator("palette")
    def validate_palette(cls, value: Dict[int, str]) -> Dict[int, str]:
        if not value:
            raise ValueError("Palette must include at least one classification/color pair.")

        normalized: Dict[int, str] = {}
        for k, v in value.items():
            try:
                cls_value = int(k)
            except (TypeError, ValueError):
                raise ValueError(f"Palette keys must be classification integers; got {k}")
            if not isinstance(v, str):
                raise ValueError(f"Invalid color for class {k}: {v}")
            trimmed = v.strip()
            if trimmed.startswith("#"):
                trimmed = trimmed[1:]
            if len(trimmed) != 6:
                raise ValueError(f"Invalid color for class {k}: {v}")
            normalized[cls_value] = f"#{trimmed.upper()}"
        return normalized




def _project_download_url(project_file: ProjectFile) -> str:
    return f"{settings.api_prefix}/projects/{project_file.project_id}/files/{project_file.id}"


def _serialize_project_file(project_file: ProjectFile) -> Dict[str, Any]:
    return {
        "id": project_file.id,
        "projectId": project_file.project_id,
        "originalFilename": project_file.original_filename,
        "storedFilename": project_file.stored_filename,
        "contentType": project_file.content_type,
        "size": project_file.file_size,
        "description": project_file.description,
        "uploadedAt": project_file.uploaded_at.isoformat() if project_file.uploaded_at else None,
        "downloadUrl": _project_download_url(project_file),
    }


def _safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None




def _coerce_xyz(value: Any) -> Dict[str, Optional[float]]:
    if not isinstance(value, dict):
        return {}
    result: Dict[str, Optional[float]] = {}
    for coord in ("x", "y", "z"):
        if coord in value:
            result[coord] = _safe_float(value.get(coord))
    return result


def _extract_coordinate_system(bounds: Optional[Dict[str, Any]]) -> Optional[str]:
    if not bounds or not isinstance(bounds, dict):
        return None
    value = bounds.get("coordinateSystem")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _default_z_from_bounds(bounds: Optional[Dict[str, Any]]) -> Optional[float]:
    if not bounds or not isinstance(bounds, dict):
        return None

    min_z = None
    max_z = None

    min_bounds = bounds.get("min")
    if isinstance(min_bounds, dict):
        min_z = _safe_float(min_bounds.get("z"))

    max_bounds = bounds.get("max")
    if isinstance(max_bounds, dict):
        max_z = _safe_float(max_bounds.get("z"))

    if min_z is not None and max_z is not None:
        return (min_z + max_z) / 2.0
    if min_z is not None:
        return min_z
    if max_z is not None:
        return max_z
    return None


def _fallback_position_from_bounds(
    lat: float,
    lng: float,
    bounds: Optional[Dict[str, Any]],
    default_z: Optional[float],
) -> Optional[Dict[str, Optional[float]]]:
    if not bounds or not isinstance(bounds, dict):
        return None

    geographic = bounds.get("geographic")
    if not isinstance(geographic, dict):
        return None

    south_west = geographic.get("southWest")
    north_east = geographic.get("northEast")
    if not (isinstance(south_west, dict) and isinstance(north_east, dict)):
        return None

    sw_lat = south_west.get("lat")
    sw_lng = south_west.get("lng")
    ne_lat = north_east.get("lat")
    ne_lng = north_east.get("lng")

    if not all(_is_number(value) for value in (sw_lat, sw_lng, ne_lat, ne_lng)):
        return None

    sw_lat = float(sw_lat)  # type: ignore[arg-type]
    sw_lng = float(sw_lng)  # type: ignore[arg-type]
    ne_lat = float(ne_lat)  # type: ignore[arg-type]
    ne_lng = float(ne_lng)  # type: ignore[arg-type]

    lat_span = ne_lat - sw_lat
    lng_span = ne_lng - sw_lng
    if lat_span == 0 or lng_span == 0:
        return None

    min_bounds = bounds.get("min")
    max_bounds = bounds.get("max")
    if not (isinstance(min_bounds, dict) and isinstance(max_bounds, dict)):
        return None

    min_x = _safe_float(min_bounds.get("x"))
    min_y = _safe_float(min_bounds.get("y"))
    max_x = _safe_float(max_bounds.get("x"))
    max_y = _safe_float(max_bounds.get("y"))

    if None in (min_x, min_y, max_x, max_y):
        return None

    x_span = max_x - min_x  # type: ignore[operator]
    y_span = max_y - min_y  # type: ignore[operator]
    if x_span == 0 or y_span == 0:
        return None

    # Clamp input lat/lng to bounds to avoid extrapolation surprises
    clamped_lat = min(max(lat, sw_lat), ne_lat)
    clamped_lng = min(max(lng, sw_lng), ne_lng)

    lat_ratio = (clamped_lat - sw_lat) / lat_span
    lng_ratio = (clamped_lng - sw_lng) / lng_span

    x = min_x + lng_ratio * x_span  # type: ignore[operator]
    y = min_y + lat_ratio * y_span  # type: ignore[operator]
    z = default_z

    return {
        "x": float(x),
        "y": float(y),
        "z": float(z) if z is not None else None,
    }


def _position_within_bounds(
    position: Optional[Dict[str, Optional[float]]],
    bounds: Optional[Dict[str, Any]],
    tolerance: float = 0.0,
) -> bool:
    if position is None:
        return False
    if not bounds or not isinstance(bounds, dict):
        return True

    min_bounds = bounds.get("min")
    max_bounds = bounds.get("max")
    if not (isinstance(min_bounds, dict) and isinstance(max_bounds, dict)):
        return True

    x = position.get("x")
    y = position.get("y")
    if not (_is_number(x) and _is_number(y)):
        return False

    min_x = _safe_float(min_bounds.get("x"))
    max_x = _safe_float(max_bounds.get("x"))
    min_y = _safe_float(min_bounds.get("y"))
    max_y = _safe_float(max_bounds.get("y"))

    if None in (min_x, max_x, min_y, max_y):
        return True

    x_val = float(x)  # type: ignore[arg-type]
    y_val = float(y)  # type: ignore[arg-type]

    return (
        (min_x - tolerance) <= x_val <= (max_x + tolerance)  # type: ignore[operator]
        and (min_y - tolerance) <= y_val <= (max_y + tolerance)  # type: ignore[operator]
    )


def _build_geographic_to_local_transformer(bounds: Optional[Dict[str, Any]]) -> Optional["Transformer"]:
    if Transformer is None or CRS is None:
        return None

    coord_system = _extract_coordinate_system(bounds)
    if not coord_system:
        return None

    try:
        target_crs = CRS.from_user_input(coord_system)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Unable to parse CRS '%s': %s", coord_system, exc)
        return None

    try:
        return Transformer.from_crs("EPSG:4326", target_crs, always_xy=True)  # type: ignore[arg-type]
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Unable to build transformer to CRS '%s': %s", coord_system, exc)

    if isinstance(coord_system, str):
        epsg_match = None
        if "EPSG:" in coord_system.upper():
            start = coord_system.upper().index("EPSG:")
            remainder = coord_system[start:]
            digits = "".join(ch for ch in remainder if ch.isdigit())
            if digits:
                epsg_match = digits
        if epsg_match:
            try:
                fallback_crs = CRS.from_epsg(int(epsg_match))
                return Transformer.from_crs("EPSG:4326", fallback_crs, always_xy=True)  # type: ignore[arg-type]
            except Exception as fallback_exc:  # pragma: no cover - defensive
                logger.warning(
                    "Unable to build transformer from extracted EPSG '%s': %s",
                    epsg_match,
                    fallback_exc,
                )
    return None


def _build_local_to_geographic_transformer(bounds: Optional[Dict[str, Any]]) -> Optional["Transformer"]:
    if Transformer is None or CRS is None:
        return None

    coord_system = _extract_coordinate_system(bounds)
    if not coord_system:
        return None

    try:
        source_crs = CRS.from_user_input(coord_system)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Unable to parse CRS '%s' for reverse transform: %s", coord_system, exc)
        return None

    try:
        return Transformer.from_crs(source_crs, "EPSG:4326", always_xy=True)  # type: ignore[arg-type]
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Unable to build reverse transformer from CRS '%s': %s", coord_system, exc)

    if isinstance(coord_system, str):
        epsg_match = None
        if "EPSG:" in coord_system.upper():
            start = coord_system.upper().index("EPSG:")
            remainder = coord_system[start:]
            digits = "".join(ch for ch in remainder if ch.isdigit())
            if digits:
                epsg_match = digits
        if epsg_match:
            try:
                fallback_crs = CRS.from_epsg(int(epsg_match))
                return Transformer.from_crs(fallback_crs, "EPSG:4326", always_xy=True)  # type: ignore[arg-type]
            except Exception as fallback_exc:  # pragma: no cover - defensive
                logger.warning(
                    "Unable to build reverse transformer from extracted EPSG '%s': %s",
                    epsg_match,
                    fallback_exc,
                )
    return None


def _is_number(value: Any) -> bool:
    try:
        float(value)  # type: ignore[arg-type]
        return True
    except (TypeError, ValueError):
        return False


def _normalize_pointcloud_bounds(bounds: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not bounds or not isinstance(bounds, dict):
        return None

    normalized: Dict[str, Any]
    if "min" in bounds and "max" in bounds:
        normalized = {
            "min": _coerce_xyz(bounds.get("min")),
            "max": _coerce_xyz(bounds.get("max")),
        }
    elif all(key in bounds for key in ("min_x", "min_y", "max_x", "max_y")):
        normalized = {
            "min": {
                "x": _safe_float(bounds.get("min_x")),
                "y": _safe_float(bounds.get("min_y")),
                "z": _safe_float(bounds.get("min_z")),
            },
            "max": {
                "x": _safe_float(bounds.get("max_x")),
                "y": _safe_float(bounds.get("max_y")),
                "z": _safe_float(bounds.get("max_z")),
            },
        }
    else:
        return bounds

    if "geographic" in bounds and isinstance(bounds["geographic"], dict):
        normalized["geographic"] = bounds["geographic"]
    if "coordinateSystem" in bounds:
        normalized["coordinateSystem"] = bounds["coordinateSystem"]

    return normalized


def _serialize_pointcloud_for_project(pointcloud: PointCloud) -> Dict[str, Any]:
    bounds = _normalize_pointcloud_bounds(pointcloud.bounds)
    return {
        "id": pointcloud.id,
        "name": pointcloud.name,
        "status": pointcloud.status.value if pointcloud.status else None,
        "date": pointcloud.created_at.isoformat() if pointcloud.created_at else None,
        "url": pointcloud.url,
        "pointCount": pointcloud.point_count,
        "fileSize": pointcloud.file_size,
        "bounds": bounds,
        "footprint": pointcloud.footprint,
        "coordinateSystem": bounds.get("coordinateSystem") if isinstance(bounds, dict) else None,
        "classification": pointcloud.classification,
        "projectId": pointcloud.project_id,
    }


def _serialize_project(
    project: Project,
    *,
    pointcloud_count: int = 0,
    total_file_size: int = 0,
    file_count: int = 0,
    pole_count: int = 0,
) -> Dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "geometry": project.geometry,
        "centroid": project.centroid,
        "metadata": project.metadata_json,
        "poles": project.poles or [],
        "pointCloudCount": pointcloud_count,
        "fileCount": file_count,
        "totalFileSize": total_file_size,
        "poleCount": pole_count,
        "poleCount": len(project.poles or []),
        "createdAt": project.created_at.isoformat() if project.created_at else None,
        "updatedAt": project.updated_at.isoformat() if project.updated_at else None,
    }


def _calculate_project_totals(project: Project) -> Dict[str, int]:
    pointclouds = project.pointclouds or []
    files = project.files or []
    return {
        "pointcloud_count": len(pointclouds),
        "file_count": len(files),
        "total_file_size": sum((f.file_size or 0) for f in files),
        "pole_count": len(project.poles or []),
    }


def _serialize_project_detail(
    project: Project,
    *,
    pointcloud_count: Optional[int] = None,
    total_file_size: Optional[int] = None,
    file_count: Optional[int] = None,
    pole_count: Optional[int] = None,
) -> Dict[str, Any]:
    if pointcloud_count is None or total_file_size is None or file_count is None:
        totals = _calculate_project_totals(project)
        pointcloud_count = totals["pointcloud_count"] if pointcloud_count is None else pointcloud_count
        total_file_size = totals["total_file_size"] if total_file_size is None else total_file_size
        file_count = totals["file_count"] if file_count is None else file_count
        pole_count = totals["pole_count"] if pole_count is None else pole_count

    return {
        **_serialize_project(
            project,
            pointcloud_count=pointcloud_count,
            total_file_size=total_file_size,
            file_count=file_count,
            pole_count=pole_count or 0,
        ),
        "files": [
            _serialize_project_file(project_file)
            for project_file in sorted(
                project.files or [],
                key=lambda pf: pf.uploaded_at or datetime.min,
                reverse=True,
            )
        ],
        "pointClouds": [
            _serialize_pointcloud_for_project(pc)
            for pc in sorted(
                project.pointclouds or [],
                key=lambda cloud: cloud.created_at or datetime.min,
                reverse=True,
            )
        ],
    }

@router.get("/pointclouds", response_model=List[dict])
def get_pointclouds(db: Session = Depends(get_db)):
    """Get all point clouds"""
    pointclouds = db.query(PointCloud).order_by(PointCloud.created_at.desc()).all()

    results: List[Dict[str, Any]] = []
    for pc in pointclouds:
        bounds = _normalize_pointcloud_bounds(pc.bounds)
        results.append(
            {
                "id": pc.id,
                "name": pc.name,
                "size": pc.file_size,
                "date": pc.created_at.isoformat(),
                "status": pc.status.value,
                "url": pc.url,
                "pointCount": pc.point_count,
                "classification": pc.classification,
                "projectId": pc.project_id,
                "project": pc.project.name if pc.project else None,
                "errorMessage": pc.error_message,
                "bounds": bounds,
                "footprint": pc.footprint,
                "coordinateSystem": bounds.get("coordinateSystem") if isinstance(bounds, dict) else None,
            }
        )
    return results

@router.get("/pointclouds/latest")
def get_latest_pointcloud(db: Session = Depends(get_db)):
    """Get the latest completed point cloud"""
    pointcloud = db.query(PointCloud)\
        .filter(PointCloud.status == ProcessingStatus.COMPLETED)\
        .order_by(PointCloud.created_at.desc())\
        .first()

    if not pointcloud:
        raise HTTPException(status_code=404, detail="No completed point clouds found")

    bounds = _normalize_pointcloud_bounds(pointcloud.bounds)
    return {
        "id": pointcloud.id,
        "name": pointcloud.name,
        "size": pointcloud.file_size,
        "date": pointcloud.created_at.isoformat(),
        "status": pointcloud.status.value,
        "url": pointcloud.url,
        "pointCount": pointcloud.point_count,
        "classification": pointcloud.classification,
        "projectId": pointcloud.project_id,
        "project": pointcloud.project.name if pointcloud.project else None,
        "errorMessage": pointcloud.error_message,
        "bounds": bounds,
        "footprint": pointcloud.footprint,
        "coordinateSystem": bounds.get("coordinateSystem") if isinstance(bounds, dict) else None,
    }

@router.get("/pointclouds/{pointcloud_id}")
def get_pointcloud(pointcloud_id: int, db: Session = Depends(get_db)):
    """Get a specific point cloud"""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    bounds = _normalize_pointcloud_bounds(pointcloud.bounds)
    return {
        "id": pointcloud.id,
        "name": pointcloud.name,
        "size": pointcloud.file_size,
        "date": pointcloud.created_at.isoformat(),
        "status": pointcloud.status.value,
        "url": pointcloud.url,
        "pointCount": pointcloud.point_count,
        "classification": pointcloud.classification,
        "projectId": pointcloud.project_id,
        "project": pointcloud.project.name if pointcloud.project else None,
        "errorMessage": pointcloud.error_message,
        "bounds": bounds,
        "footprint": pointcloud.footprint,
        "coordinateSystem": bounds.get("coordinateSystem") if isinstance(bounds, dict) else None,
    }


@router.get("/pointclouds/{pointcloud_id}/poles")
def get_pointcloud_poles(pointcloud_id: int, db: Session = Depends(get_db)) -> Dict[str, Any]:
    """Return poles associated with the point cloud's project, transformed to local coordinates when possible."""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    project = pointcloud.project
    bounds = _normalize_pointcloud_bounds(pointcloud.bounds)
    transformer = _build_geographic_to_local_transformer(bounds)
    reverse_transformer = _build_local_to_geographic_transformer(bounds)
    default_z = _default_z_from_bounds(bounds)
    coordinate_system = _extract_coordinate_system(bounds)

    poles: List[Dict[str, Any]] = []
    source_poles: List[Any] = project.poles if project and isinstance(project.poles, list) else []

    geographic_bounds = None
    if isinstance(bounds, dict):
        geographic_bounds = bounds.get("geographic")

    footprint_geometry = None
    buffered_footprint = None
    if pointcloud.footprint and shapely_shape is not None and ShapelyPoint is not None:
        try:
            footprint_geometry = shapely_shape(pointcloud.footprint)
            if footprint_geometry and not footprint_geometry.is_empty:
                try:
                    footprint_geometry = footprint_geometry.buffer(0)
                except ShapelyError:
                    pass
                try:
                    buffered_footprint = footprint_geometry.buffer(1e-5)
                except ShapelyError:
                    buffered_footprint = footprint_geometry
            else:
                footprint_geometry = None
        except ShapelyError as exc:  # pragma: no cover - defensive
            logger.warning(
                "Failed to parse footprint geometry for point cloud %s: %s",
                pointcloud_id,
                exc,
            )
            footprint_geometry = None

    for index, entry in enumerate(source_poles):
        if not isinstance(entry, dict):
            continue

        position_override = entry.get("position_override") if isinstance(entry.get("position_override"), dict) else None
        override_has_xy = (
            isinstance(position_override, dict)
            and _is_number(position_override.get("x"))
            and _is_number(position_override.get("y"))
        )

        lat_value = entry.get("lat")
        lng_value = entry.get("lng")

        if override_has_xy:
            override_lat = position_override.get("lat")
            override_lng = position_override.get("lng")
            if _is_number(override_lat) and _is_number(override_lng):
                lat_value = override_lat
                lng_value = override_lng
            elif reverse_transformer:
                try:
                    override_lng, override_lat = reverse_transformer.transform(
                        float(position_override.get("x")),  # type: ignore[arg-type]
                        float(position_override.get("y")),  # type: ignore[arg-type]
                    )
                    lat_value = override_lat
                    lng_value = override_lng
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(
                        "Failed to reverse-transform manual pole override for point cloud %s: %s",
                        pointcloud_id,
                        exc,
                    )

        if not (_is_number(lat_value) and _is_number(lng_value)):
            if override_has_xy and _is_number(entry.get("lat")) and _is_number(entry.get("lng")):
                lat_value = entry.get("lat")
                lng_value = entry.get("lng")
            else:
                continue

        lat = float(lat_value)  # type: ignore[arg-type]
        lng = float(lng_value)  # type: ignore[arg-type]
        alt_value = entry.get("alt")
        alt = float(alt_value) if _is_number(alt_value) else None

        if not override_has_xy and footprint_geometry is not None:
            try:
                pole_point = ShapelyPoint(lng, lat)
                if not footprint_geometry.contains(pole_point):
                    if buffered_footprint is None or not buffered_footprint.contains(pole_point):
                        continue
            except ShapelyError as exc:  # pragma: no cover - defensive
                logger.warning(
                    "Failed to evaluate pole %s against footprint: %s",
                    entry.get("id", index),
                    exc,
                )
                continue
        elif isinstance(geographic_bounds, dict):
            south_west = geographic_bounds.get("southWest")
            north_east = geographic_bounds.get("northEast")
            if not override_has_xy and isinstance(south_west, dict) and isinstance(north_east, dict):
                sw_lat = south_west.get("lat")
                sw_lng = south_west.get("lng")
                ne_lat = north_east.get("lat")
                ne_lng = north_east.get("lng")
                if all(_is_number(v) for v in (sw_lat, sw_lng, ne_lat, ne_lng)):
                    if not (
                        float(sw_lat) <= lat <= float(ne_lat)  # type: ignore[arg-type]
                        and float(sw_lng) <= lng <= float(ne_lng)  # type: ignore[arg-type]
                    ):
                        continue

        position: Optional[Dict[str, Optional[float]]] = None
        position_source: Optional[str] = None
        if override_has_xy:
            x_value = position_override.get("x")
            y_value = position_override.get("y")
            z_value = position_override.get("z") if _is_number(position_override.get("z")) else None
            position = {
                "x": float(x_value),  # type: ignore[arg-type]
                "y": float(y_value),  # type: ignore[arg-type]
                "z": float(z_value) if z_value is not None else None,
            }
            position_source = position_override.get("source") or "manual"
            if position["z"] is None:
                if _is_number(position_override.get("alt")):
                    position["z"] = float(position_override.get("alt"))  # type: ignore[arg-type]
                elif alt is not None:
                    position["z"] = alt
                elif default_z is not None:
                    position["z"] = default_z
        if position is None and transformer:
            try:
                x, y = transformer.transform(lng, lat)
                z = alt if alt is not None else default_z
                position = {
                    "x": float(x),
                    "y": float(y),
                    "z": float(z) if z is not None else None,
                }
                position_source = "transformer"
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "Failed to transform pole coordinates for point cloud %s: %s",
                    pointcloud_id,
                    exc,
                )
        if position is None:
            position = _fallback_position_from_bounds(lat, lng, bounds, alt if alt is not None else default_z)
            if position:
                position_source = "geographic-bounds"

        if position and not _position_within_bounds(position, bounds, tolerance=0.01):
            logger.debug(
                "Pole %s (lat=%s, lng=%s) produced position %s outside point cloud bounds; skipping.",
                entry.get("name") or index,
                lat,
                lng,
                position,
            )
            position = None

        if position is None:
            continue

        pole_id = entry.get("id", index)
        position_override_serialized: Optional[Dict[str, Optional[float]]] = None
        if override_has_xy:
            position_override_serialized = {
                "x": float(position_override.get("x")),  # type: ignore[arg-type]
                "y": float(position_override.get("y")),  # type: ignore[arg-type]
                "z": float(position_override.get("z")) if _is_number(position_override.get("z")) else None,
                "lat": float(position_override.get("lat")) if _is_number(position_override.get("lat")) else lat,
                "lng": float(position_override.get("lng")) if _is_number(position_override.get("lng")) else lng,
                "alt": float(position_override.get("alt")) if _is_number(position_override.get("alt")) else alt,
                "source": position_override.get("source") or "manual",
            }

        poles.append(
            {
                "id": pole_id,
                "name": entry.get("name"),
                "lat": lat,
                "lng": lng,
                "alt": alt,
                "position": position,
                "positionSource": position_source,
                "positionOverride": position_override_serialized,
            }
        )

    return {
        "pointcloudId": pointcloud.id,
        "projectId": project.id if project else None,
        "coordinateSystem": coordinate_system,
        "poles": poles,
    }


@router.patch("/pointclouds/{pointcloud_id}/poles/{pole_identifier}")
def update_pointcloud_pole(
    pointcloud_id: int,
    pole_identifier: str,
    payload: PointCloudPoleUpdatePayload,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    project = pointcloud.project
    if not project:
        raise HTTPException(status_code=400, detail="Point cloud is not associated with a project")

    poles = project.poles if isinstance(project.poles, list) else []
    if not poles:
        raise HTTPException(status_code=404, detail="No poles defined for project")

    identifier_str = str(pole_identifier)
    target_index: Optional[int] = None

    for index, entry in enumerate(poles):
        if not isinstance(entry, dict):
            continue
        entry_identifier = entry.get("id", index)
        if str(entry_identifier) == identifier_str:
            target_index = index
            break

    if target_index is None:
        # Fall back to treating the identifier as a numeric index when possible
        try:
            numeric_index = int(identifier_str)
        except ValueError:
            numeric_index = None
        if numeric_index is not None and 0 <= numeric_index < len(poles):
            target_index = numeric_index

    if target_index is None:
        raise HTTPException(status_code=404, detail="Pole not found")

    existing_entry = poles[target_index]
    if not isinstance(existing_entry, dict):
        existing_entry = {}

    update_data = payload.dict(exclude_unset=True)
    bounds = _normalize_pointcloud_bounds(pointcloud.bounds)
    reverse_transformer = _build_local_to_geographic_transformer(bounds)

    updated_entry: Dict[str, Any] = dict(existing_entry)

    if "name" in update_data:
        updated_entry["name"] = update_data["name"]

    if "lat" in update_data:
        updated_entry["lat"] = update_data["lat"]
    if "lng" in update_data:
        updated_entry["lng"] = update_data["lng"]
    if "alt" in update_data:
        updated_entry["alt"] = update_data["alt"]

    position_payload = update_data.get("position")
    position_override: Optional[Dict[str, Any]] = None
    if position_payload:
        x = float(position_payload["x"])
        y = float(position_payload["y"])
        z = position_payload.get("z")

        manual_lat: Optional[float] = None
        manual_lng: Optional[float] = None

        if reverse_transformer:
            try:
                manual_lng, manual_lat = reverse_transformer.transform(x, y)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "Failed to reverse-transform pole coordinates for point cloud %s: %s",
                    pointcloud_id,
                    exc,
                )

        if manual_lat is not None and manual_lng is not None:
            updated_entry["lat"] = manual_lat
            updated_entry["lng"] = manual_lng

        if z is not None:
            try:
                updated_entry["alt"] = float(z)
            except (TypeError, ValueError):
                pass

        position_override = {
            "x": x,
            "y": y,
            "z": float(z) if z is not None and _is_number(z) else None,
            "lat": manual_lat if manual_lat is not None else updated_entry.get("lat"),
            "lng": manual_lng if manual_lng is not None else updated_entry.get("lng"),
            "alt": float(z) if z is not None and _is_number(z) else updated_entry.get("alt"),
            "source": "manual",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }

    if position_override:
        updated_entry["position_override"] = position_override

    poles[target_index] = updated_entry
    project.poles = poles
    db.add(project)
    db.commit()
    db.refresh(project)

    refreshed = get_pointcloud_poles(pointcloud_id, db=db)
    updated_pole = next(
        (pole for pole in refreshed["poles"] if str(pole.get("id")) == identifier_str),
        None,
    )

    if updated_pole is None:
        raise HTTPException(status_code=500, detail="Failed to serialize updated pole")

    return updated_pole


@router.patch("/pointclouds/{pointcloud_id}")
def update_pointcloud_endpoint(
    pointcloud_id: int,
    payload: PointCloudUpdatePayload,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    update_data = payload.dict(exclude_unset=True, by_alias=True)

    if "projectId" in update_data:
        new_project_id = update_data["projectId"]
        if new_project_id is None:
            pointcloud.project_id = None
        else:
            project = db.query(Project).filter(Project.id == new_project_id).first()
            if not project:
                raise HTTPException(status_code=400, detail="Project not found")
            pointcloud.project_id = project.id

    if "name" in update_data and update_data["name"]:
        pointcloud.name = update_data["name"]

    db.add(pointcloud)
    db.commit()
    db.refresh(pointcloud)

    bounds = _normalize_pointcloud_bounds(pointcloud.bounds)
    return {
        "id": pointcloud.id,
        "name": pointcloud.name,
        "size": pointcloud.file_size,
        "date": pointcloud.created_at.isoformat(),
        "status": pointcloud.status.value,
        "url": pointcloud.url,
        "pointCount": pointcloud.point_count,
        "classification": pointcloud.classification,
        "projectId": pointcloud.project_id,
        "project": pointcloud.project.name if pointcloud.project else None,
        "bounds": bounds,
        "coordinateSystem": bounds.get("coordinateSystem") if isinstance(bounds, dict) else None,
    }

@router.delete("/pointclouds/{pointcloud_id}")
def delete_pointcloud(pointcloud_id: int, db: Session = Depends(get_db)):
    """Delete a point cloud"""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    # Delete files
    if pointcloud.url:
        # Extract directory from URL (e.g., /pointclouds/55/metadata.json -> pointclouds/55/)
        url_parts = pointcloud.url.split('/')
        if len(url_parts) >= 3:
            pointcloud_dir = os.path.join(settings.pointcloud_output_dir, url_parts[-2])
            if os.path.exists(pointcloud_dir):
                shutil.rmtree(pointcloud_dir)

    db.delete(pointcloud)
    db.commit()

    return {"message": "Point cloud deleted successfully"}


@router.post(
    "/pointclouds/{pointcloud_id}/classifications/apply",
    response_model=ClassificationEditResponsePayload,
    status_code=202,
)
def apply_classification_edits(
    pointcloud_id: int,
    payload: ClassificationEditRequestPayload,
    db: Session = Depends(get_db),
):
    """Queue classification edits for a point cloud."""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    if pointcloud.status != ProcessingStatus.COMPLETED:
        raise HTTPException(status_code=400, detail="Cannot edit classifications while processing is incomplete.")

    total_points = sum(len(op.points) for op in payload.operations)
    if total_points == 0:
        raise HTTPException(status_code=400, detail="No points supplied in payload.")

    # Ensure the table exists (convenience for dev environments without migrations)
    ClassificationEditBatch.__table__.create(bind=db.get_bind(), checkfirst=True)

    unstable_count = sum(
        1 for op in payload.operations for point in op.points if point.unstable
    )

    operations_json = [
        op.dict(by_alias=True, exclude_unset=True) for op in payload.operations
    ]
    metadata: Dict[str, Any] = {}
    if payload.client_timestamp:
        metadata["clientTimestamp"] = payload.client_timestamp.isoformat()
    if payload.note:
        metadata["note"] = payload.note

    # Collect selection metadata for easier debugging
    selection_metadata = [
        op.metadata for op in payload.operations if op.metadata is not None
    ]
    if selection_metadata:
        metadata["operationsMetadata"] = selection_metadata

    operation_id = str(uuid.uuid4())

    batch = ClassificationEditBatch(
        id=operation_id,
        pointcloud_id=pointcloud_id,
        status=ClassificationEditStatus.QUEUED,
        total_points=total_points,
        unstable_count=unstable_count,
        metadata_payload=metadata or None,
        operations=jsonable_encoder(operations_json),
        tiles_total=len(operations_json),
    )

    db.add(batch)
    db.commit()
    db.refresh(batch)

    logger.info(
        "Queued classification batch %s for point cloud %s (%d operations / %d points)",
        batch.id,
        batch.pointcloud_id,
        len(operations_json),
        total_points,
    )

    enqueue_classification_edit_batch(batch)

    return ClassificationEditResponsePayload(
        operationId=operation_id,
        status=ClassificationEditStatus.QUEUED,
        acceptedPoints=total_points,
    )


@router.get("/pointclouds/{pointcloud_id}/classifications/overrides")
def get_classification_overrides(pointcloud_id: int, db: Session = Depends(get_db)):
    """Return persisted classification overrides for the point cloud."""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    overrides_path = os.path.join(
        settings.pointcloud_output_dir,
        str(pointcloud_id),
        "classification_overrides.json",
    )

    if not os.path.exists(overrides_path):
        return {}

    try:
        with open(overrides_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to parse overrides: {exc}") from exc


@router.get(
    "/pointclouds/{pointcloud_id}/classifications/status",
    response_model=List[ClassificationEditStatusPayload],
)
def get_classification_status(pointcloud_id: int, db: Session = Depends(get_db)):
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    batches = (
        db.query(ClassificationEditBatch)
        .filter(ClassificationEditBatch.pointcloud_id == pointcloud_id)
        .order_by(ClassificationEditBatch.received_at.desc())
        .all()
    )

    results: List[ClassificationEditStatusPayload] = []
    for batch in batches:
        results.append(
            ClassificationEditStatusPayload(
                operationId=batch.id,
                status=batch.status,
                totalPoints=int(batch.total_points or 0),
                pointsProcessed=int(batch.points_processed or 0),
                tilesTotal=int(batch.tiles_total or 0),
                tilesProcessed=int(batch.tiles_processed or 0),
                unstableCount=int(batch.unstable_count or 0),
                receivedAt=batch.received_at,
                updatedAt=batch.updated_at,
                completedAt=batch.completed_at,
            )
        )
    return results


@router.get("/projects")
def get_projects(db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    projects = []
    for entry in list_projects(db):
        project = entry["project"]
        projects.append(
            _serialize_project(
                project,
                pointcloud_count=entry.get("pointcloud_count", 0),
                total_file_size=entry.get("total_file_size", 0),
                file_count=entry.get("file_count", 0),
                pole_count=entry.get("pole_count", 0),
            )
        )
    return projects


@router.post("/projects", status_code=201)
def create_project_endpoint(payload: ProjectCreatePayload, db: Session = Depends(get_db)) -> Dict[str, Any]:
    try:
        project = create_project(
            db,
            name=payload.name,
            description=payload.description,
            geometry=payload.geometry,
            centroid=payload.centroid,
            metadata=payload.metadata,
        )
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Project name already exists") from exc

    project_with_relations = get_project(db, project.id) or project
    return _serialize_project_detail(project_with_relations)


@router.get("/projects/{project_id}")
def get_project_detail(project_id: int, db: Session = Depends(get_db)) -> Dict[str, Any]:
    project = get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return _serialize_project_detail(project)


@router.patch("/projects/{project_id}")
def update_project_endpoint(
    project_id: int,
    payload: ProjectUpdatePayload,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    project = get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    update_fields = payload.model_dump(exclude_unset=True)
    if not update_fields:
        return _serialize_project_detail(project)

    try:
        project = update_project(db, project, **update_fields)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Project name already exists") from exc

    project = get_project(db, project.id) or project
    return _serialize_project_detail(project)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project_endpoint(project_id: int, db: Session = Depends(get_db)) -> Response:
    project = get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    delete_project(db, project)
    return Response(status_code=204)


@router.post("/projects/{project_id}/files")
async def upload_project_file(
    project_id: int,
    file: UploadFile = File(...),
    description: Optional[str] = Form(None),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    project = get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_file, parse_result, parse_error = add_file_to_project(db, project, file, description=description)
    await file.close()

    project = get_project(db, project_id) or project
    totals = _calculate_project_totals(project)
    response: Dict[str, Any] = {
        "file": _serialize_project_file(project_file),
        "project": _serialize_project_detail(project, **totals),
    }

    if parse_result:
        response["parseSummary"] = {
            "totalFeatures": parse_result.total_features,
            "poleCount": parse_result.pole_count,
            "centroidUpdated": bool(parse_result.centroid),
            "geometryUpdated": bool(parse_result.geometry),
        }

    if parse_error:
        response["parseError"] = parse_error

    return response


@router.get("/projects/{project_id}/files/{file_id}")
def download_project_file(
    project_id: int,
    file_id: int,
    db: Session = Depends(get_db),
):
    project_file = get_project_file(db, project_id, file_id)
    if not project_file:
        raise HTTPException(status_code=404, detail="File not found")

    file_path = os.path.join(
        settings.upload_dir,
        "projects",
        str(project_file.project_id),
        project_file.stored_filename,
    )
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File content missing on disk")

    return FileResponse(
        file_path,
        filename=project_file.original_filename,
        media_type=project_file.content_type or "application/octet-stream",
    )


@router.delete("/projects/{project_id}/files/{file_id}", status_code=204)
def delete_project_file_endpoint(
    project_id: int,
    file_id: int,
    db: Session = Depends(get_db),
) -> Response:
    project_file = get_project_file(db, project_id, file_id)
    if not project_file:
        raise HTTPException(status_code=404, detail="File not found")

    delete_project_file(db, project_file)
    return Response(status_code=204)

@router.post("/upload")
async def upload_pointcloud_chunk(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    filename: str = Form(...),
    chunkIndex: int = Form(...),
    totalChunks: int = Form(...),
    projectId: Optional[int] = Form(None),
    db: Session = Depends(get_db)
):
    """Upload point cloud file in chunks"""

    # Create temp directory for chunks using consistent naming
    # Use filename and total chunks as identifier to ensure all chunks go to same directory
    safe_filename = filename.replace(" ", "_").replace("/", "_").replace("\\", "_")
    temp_dir = os.path.join(settings.upload_dir, f"temp_{safe_filename}_{totalChunks}")
    os.makedirs(temp_dir, exist_ok=True)

    # Save this chunk
    chunk_file_location = os.path.join(temp_dir, f"chunk_{chunkIndex:06d}")
    try:
        with open(chunk_file_location, "wb") as chunk_file:
            shutil.copyfileobj(file.file, chunk_file)
    finally:
        await file.close()

    chunk_size = os.path.getsize(chunk_file_location)
    print(f"📦 Saved chunk {chunkIndex}/{totalChunks-1}: {chunk_size} bytes to {chunk_file_location}")

    # If this is the last chunk, reconstruct the file and start processing
    if chunkIndex == totalChunks - 1:
        final_file_location = os.path.join(settings.upload_dir, filename)

        # Reconstruct file from chunks
        print(f"🔧 Reconstructing file from {totalChunks} chunks...")
        total_bytes = 0
        with open(final_file_location, "wb") as final_file:
            for i in range(totalChunks):
                chunk_path = os.path.join(temp_dir, f"chunk_{i:06d}")
                if os.path.exists(chunk_path):
                    chunk_size = os.path.getsize(chunk_path)
                    with open(chunk_path, "rb") as chunk_file:
                        bytes_copied = shutil.copyfileobj(chunk_file, final_file)
                        total_bytes += chunk_size
                    print(f"✅ Copied chunk {i}: {chunk_size} bytes")
                else:
                    print(f"❌ Missing chunk {i} at {chunk_path}")

        print(f"📁 Final file: {final_file_location}, Total bytes: {total_bytes}")

        # Verify file integrity by checking first few bytes
        with open(final_file_location, "rb") as f:
            header_bytes = f.read(16)
            print(f"🔍 File header (first 16 bytes): {header_bytes}")
            print(f"🔍 Header as hex: {header_bytes.hex()}")
            print(f"🔍 Header as string: {repr(header_bytes)}")

        # Clean up temp directory
        shutil.rmtree(temp_dir)

        # Get file size
        file_size = os.path.getsize(final_file_location)

        project_id_value: Optional[int] = None
        if projectId is not None:
            project = db.query(Project).filter(Project.id == projectId).first()
            if not project:
                if os.path.exists(final_file_location):
                    os.remove(final_file_location)
                raise HTTPException(status_code=400, detail="Project not found")
            project_id_value = project.id

        # Create database record
        pointcloud = PointCloud(
            name=filename,
            original_filename=filename,
            file_size=file_size,
            status=ProcessingStatus.PENDING,
            project_id=project_id_value,
        )

        try:
            db.add(pointcloud)
            db.commit()
            db.refresh(pointcloud)
        except Exception as exc:
            db.rollback()
            if os.path.exists(final_file_location):
                os.remove(final_file_location)
            logger.exception("Failed to persist point cloud record for %s", filename)
            raise HTTPException(status_code=500, detail="Failed to record point cloud upload") from exc

        # Start background processing
        background_tasks.add_task(
            process_pointcloud_file,
            pointcloud.id,
            final_file_location
        )

        return {
            "message": "File uploaded successfully",
            "pointcloud_id": pointcloud.id,
            "status": "processing",
            "projectId": pointcloud.project_id,
        }

    return {
        "message": f"Chunk {chunkIndex + 1}/{totalChunks} uploaded successfully"
    }

async def process_pointcloud_file(pointcloud_id: int, file_path: str):
    """Background task to process the uploaded point cloud file"""
    db = SessionLocal()
    try:
        pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
        if not pointcloud:
            return

        # Update status to processing
        pointcloud.status = ProcessingStatus.PROCESSING
        db.commit()

        # Create processor and process file
        processor = PointCloudProcessor()
        success = await processor.process_las_to_copc(
            file_path,
            pointcloud_id,
            pointcloud.name,
            db  # Pass database session for classification color auto-generation
        )

        if success:
            # Update database with results
            metadata = processor.get_metadata()
            pointcloud.status = ProcessingStatus.COMPLETED
            pointcloud.url = f"/pointclouds/{pointcloud_id}/data.copc.laz"
            pointcloud.point_count = metadata.get('point_count')
            pointcloud.bounds = metadata.get('bounds')
            pointcloud.classification = metadata.get('classification')
            pointcloud.footprint = metadata.get('footprint')
            pointcloud.coverage_area_km2 = metadata.get('coverage_area_km2')
            pointcloud.coverage_area_sqft = metadata.get('coverage_area_sqft')
            pointcloud.processed_at = datetime.utcnow()
        else:
            pointcloud.status = ProcessingStatus.FAILED
            pointcloud.error_message = processor.get_error_message()

        db.commit()

    except Exception as e:
        pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
        if pointcloud:
            pointcloud.status = ProcessingStatus.FAILED
            pointcloud.error_message = str(e)
            db.commit()
    finally:
        db.close()
        # Clean up original file
        if os.path.exists(file_path) and not settings.keep_raw_uploads:
            os.remove(file_path)

# Measurement endpoints
@router.get("/pointclouds/{pointcloud_id}/measurements")
def get_measurements(pointcloud_id: int, db: Session = Depends(get_db)) -> List[Dict[str, Any]]:
    """Get all measurements for a point cloud"""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    measurements = db.query(Measurement)\
        .filter(Measurement.pointcloud_id == pointcloud_id)\
        .order_by(Measurement.created_at.asc())\
        .all()

    results: List[Dict[str, Any]] = []
    for m in measurements:
        results.append({
            "id": m.id,
            "pointcloudId": m.pointcloud_id,
            "point1": {"x": m.point1_x, "y": m.point1_y, "z": m.point1_z},
            "point2": {"x": m.point2_x, "y": m.point2_y, "z": m.point2_z},
            "distance": m.distance,
            "label": m.label,
            "metadata": m.metadata_json,
            "createdAt": m.created_at.isoformat() if m.created_at else None,
            "updatedAt": m.updated_at.isoformat() if m.updated_at else None,
        })
    return results


@router.post("/pointclouds/{pointcloud_id}/measurements", status_code=201)
def create_measurement(
    pointcloud_id: int,
    payload: MeasurementCreatePayload,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Create a new measurement for a point cloud"""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    measurement = Measurement(
        pointcloud_id=pointcloud_id,
        point1_x=payload.point1.x,
        point1_y=payload.point1.y,
        point1_z=payload.point1.z,
        point2_x=payload.point2.x,
        point2_y=payload.point2.y,
        point2_z=payload.point2.z,
        distance=payload.distance,
        label=payload.label,
        metadata_json=payload.metadata,
    )

    db.add(measurement)
    db.commit()
    db.refresh(measurement)

    return {
        "id": measurement.id,
        "pointcloudId": measurement.pointcloud_id,
        "point1": {"x": measurement.point1_x, "y": measurement.point1_y, "z": measurement.point1_z},
        "point2": {"x": measurement.point2_x, "y": measurement.point2_y, "z": measurement.point2_z},
        "distance": measurement.distance,
        "label": measurement.label,
        "metadata": measurement.metadata_json,
        "createdAt": measurement.created_at.isoformat() if measurement.created_at else None,
        "updatedAt": measurement.updated_at.isoformat() if measurement.updated_at else None,
    }


@router.post("/pointclouds/{pointcloud_id}/recolor")
def recolor_pointcloud(
    pointcloud_id: int,
    payload: RecolorRequestPayload,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """
    Rewrite per-point RGB values for a point cloud using the provided palette and replace the COPC file.
    Requires PDAL on the server to emit a COPC after recoloring.
    """
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    try:
        final_path = recolor_pointcloud_file(pointcloud_id, payload.palette)
    except RecolorError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Update file size metadata
    try:
        pointcloud.file_size = final_path.stat().st_size
        db.commit()
        db.refresh(pointcloud)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Recolored file written, but database update failed: {exc}")

    # Persist palette to classification_color_schemes for UI consistency
    for cls_value, hex_color in payload.palette.items():
        scheme = db.query(ClassificationColorScheme).filter(
            ClassificationColorScheme.classification_value == cls_value
        ).first()
        if scheme:
            scheme.color = hex_color
            scheme.auto_generated = False
        else:
            scheme = ClassificationColorScheme(
                classification_value=cls_value,
                name=f"Class {cls_value}",
                color=hex_color,
                auto_generated=False
            )
            db.add(scheme)
    db.commit()

    return {
        "success": True,
        "path": str(final_path),
        "fileSize": pointcloud.file_size,
    }


@router.patch("/pointclouds/{pointcloud_id}/measurements/{measurement_id}")
def update_measurement(
    pointcloud_id: int,
    measurement_id: int,
    payload: MeasurementUpdatePayload,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Update a measurement"""
    measurement = db.query(Measurement)\
        .filter(Measurement.id == measurement_id, Measurement.pointcloud_id == pointcloud_id)\
        .first()

    if not measurement:
        raise HTTPException(status_code=404, detail="Measurement not found")

    if payload.label is not None:
        measurement.label = payload.label
    if payload.metadata is not None:
        measurement.metadata_json = payload.metadata

    db.add(measurement)
    db.commit()
    db.refresh(measurement)

    return {
        "id": measurement.id,
        "pointcloudId": measurement.pointcloud_id,
        "point1": {"x": measurement.point1_x, "y": measurement.point1_y, "z": measurement.point1_z},
        "point2": {"x": measurement.point2_x, "y": measurement.point2_y, "z": measurement.point2_z},
        "distance": measurement.distance,
        "label": measurement.label,
        "metadata": measurement.metadata_json,
        "createdAt": measurement.created_at.isoformat() if measurement.created_at else None,
        "updatedAt": measurement.updated_at.isoformat() if measurement.updated_at else None,
    }


@router.delete("/pointclouds/{pointcloud_id}/measurements/{measurement_id}", status_code=204)
def delete_measurement(
    pointcloud_id: int,
    measurement_id: int,
    db: Session = Depends(get_db)
) -> Response:
    """Delete a measurement"""
    measurement = db.query(Measurement)\
        .filter(Measurement.id == measurement_id, Measurement.pointcloud_id == pointcloud_id)\
        .first()

    if not measurement:
        raise HTTPException(status_code=404, detail="Measurement not found")

    db.delete(measurement)
    db.commit()

    return Response(status_code=204)


@router.delete("/pointclouds/{pointcloud_id}/measurements", status_code=204)
def delete_all_measurements(
    pointcloud_id: int,
    db: Session = Depends(get_db)
) -> Response:
    """Delete all measurements for a point cloud"""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    db.query(Measurement)\
        .filter(Measurement.pointcloud_id == pointcloud_id)\
        .delete()

    db.commit()

    return Response(status_code=204)


# Import SessionLocal here to avoid circular imports
from app.core.database import SessionLocal

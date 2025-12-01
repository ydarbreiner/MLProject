import logging
import os
import shutil
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import UploadFile
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.models.pointcloud import PointCloud
from app.models.project import Project
from app.models.project_file import ProjectFile
from app.services.kml_parser import KMLParseResult, KMLParserError, parse_kml_file


logger = logging.getLogger(__name__)


def _project_upload_root() -> str:
    """Return the absolute path where project uploads should be stored."""
    return os.path.join(settings.upload_dir, "projects")


def _ensure_project_dir(project_id: int) -> str:
    base_dir = _project_upload_root()
    project_dir = os.path.join(base_dir, str(project_id))
    os.makedirs(project_dir, exist_ok=True)
    return project_dir


def _safe_shape(geojson: Optional[dict]) -> Optional[BaseGeometry]:
    if not geojson:
        return None

    try:
        geometry = shape(geojson)
    except Exception as exc:  # pragma: no cover - defensive guard
        logger.warning("Failed to deserialize project geometry: %s", exc)
        return None

    return None if geometry.is_empty else geometry


def _merge_project_geometry(existing: Optional[dict], incoming: dict) -> dict:
    incoming_geom = _safe_shape(incoming)
    if incoming_geom is None:
        return existing or incoming

    existing_geom = _safe_shape(existing)
    if existing_geom is None:
        return mapping(incoming_geom)

    merged = existing_geom.union(incoming_geom)
    return mapping(merged) if not merged.is_empty else mapping(existing_geom)


def _geometry_centroid(geojson: Optional[dict]) -> Optional[Dict[str, float]]:
    geometry = _safe_shape(geojson)
    if geometry is None:
        return None

    centroid = geometry.centroid
    if centroid.is_empty:
        return None

    return {"lat": centroid.y, "lng": centroid.x}


def _rebuild_project_features_from_kml_files(
    project: Project,
    overrides: Optional[Dict[str, KMLParseResult]] = None,
) -> Dict[str, Any]:
    overrides = overrides or {}

    aggregate_geometry: Optional[dict] = None
    geometry_found = False
    poles: List[Dict[str, Any]] = []
    poles_found = False
    processed_any = False

    project_dir = _ensure_project_dir(project.id)

    for project_file in iter_project_files(project):
        filename = (project_file.original_filename or "").lower()
        if not filename.endswith((".kml", ".kmz")):
            continue

        processed_any = True
        parse_result = overrides.get(project_file.stored_filename)
        if parse_result is None:
            file_path = os.path.join(project_dir, project_file.stored_filename)
            if not os.path.exists(file_path):
                logger.warning(
                    "Missing KML file %s for project %s during rebuild",
                    project_file.stored_filename,
                    project.id,
                )
                continue
            try:
                parse_result = parse_kml_file(file_path)
            except KMLParserError as exc:
                logger.warning(
                    "Failed to parse KML %s for project %s during rebuild: %s",
                    project_file.original_filename,
                    project.id,
                    exc,
                )
                continue

        if parse_result.geometry:
            geometry_found = True
            aggregate_geometry = _merge_project_geometry(aggregate_geometry, parse_result.geometry)

        if parse_result.poles:
            poles_found = True
            poles.extend(parse_result.poles)

    centroid = _geometry_centroid(aggregate_geometry) if geometry_found else None

    return {
        "processed_any": processed_any,
        "geometry": aggregate_geometry if geometry_found else None,
        "centroid": centroid,
        "poles": poles if poles_found else None,
    }


def rebuild_project_features(project: Project) -> Dict[str, Any]:
    return _rebuild_project_features_from_kml_files(project)


def apply_rebuilt_features(
    project: Project,
    rebuild: Dict[str, Any],
    *,
    allow_clear: bool = False,
) -> Tuple[bool, bool]:
    geometry_updated = False
    poles_updated = False

    if rebuild.get("geometry") is not None:
        project.geometry = rebuild["geometry"]
        geometry_updated = True

    if rebuild.get("centroid") is not None:
        project.centroid = rebuild["centroid"]
        geometry_updated = True

    if rebuild.get("poles") is not None:
        project.poles = rebuild["poles"]
        poles_updated = True
    elif allow_clear and rebuild.get("processed_any"):
        project.poles = []
        poles_updated = True

    return geometry_updated, poles_updated


def rebuild_project_features_in_db(db: Session, project: Project, *, allow_clear: bool = True) -> bool:
    rebuild = _rebuild_project_features_from_kml_files(project)
    geometry_updated, poles_updated = apply_rebuilt_features(project, rebuild, allow_clear=allow_clear)
    if geometry_updated or poles_updated:
        db.add(project)
        db.commit()
        db.refresh(project)
        return True
    return False


def list_projects(db: Session) -> List[dict]:
    """Return projects with aggregate counts suitable for summaries."""
    projects = db.query(Project).order_by(Project.created_at.desc()).all()

    pointcloud_counts = {
        project_id: count
        for project_id, count in db.query(PointCloud.project_id, func.count(PointCloud.id))
        .filter(PointCloud.project_id.isnot(None))
        .group_by(PointCloud.project_id)
    }

    file_totals = {
        project_id: total_size
        for project_id, total_size in db.query(ProjectFile.project_id, func.coalesce(func.sum(ProjectFile.file_size), 0))
        .group_by(ProjectFile.project_id)
    }

    file_counts = {
        project_id: count
        for project_id, count in db.query(ProjectFile.project_id, func.count(ProjectFile.id))
        .group_by(ProjectFile.project_id)
    }

    results: List[dict] = []
    for project in projects:
        results.append(
            {
                "project": project,
                "pointcloud_count": int(pointcloud_counts.get(project.id, 0)),
                "total_file_size": int(file_totals.get(project.id, 0) or 0),
                "file_count": int(file_counts.get(project.id, 0)),
                "pole_count": len(project.poles or []),
            }
        )
    return results


def get_project(db: Session, project_id: int) -> Optional[Project]:
    return (
        db.query(Project)
        .options(
            selectinload(Project.pointclouds),
            selectinload(Project.files),
        )
        .filter(Project.id == project_id)
        .first()
    )


def create_project(
    db: Session,
    *,
    name: str,
    description: Optional[str] = None,
    geometry: Optional[dict] = None,
    centroid: Optional[dict] = None,
    metadata: Optional[dict] = None,
) -> Project:
    project = Project(
        name=name,
        description=description,
        geometry=geometry,
        centroid=centroid,
        metadata_json=metadata,
    )
    db.add(project)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise exc
    db.refresh(project)
    return project


def update_project(
    db: Session,
    project: Project,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    geometry: Optional[dict] = None,
    centroid: Optional[dict] = None,
    metadata: Optional[dict] = None,
) -> Project:
    if name is not None:
        project.name = name
    if description is not None:
        project.description = description
    if geometry is not None:
        project.geometry = geometry
    if centroid is not None:
        project.centroid = centroid
    if metadata is not None:
        project.metadata_json = metadata

    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def delete_project(db: Session, project: Project) -> None:
    uploads_dir = os.path.join(_project_upload_root(), str(project.id))
    db.delete(project)
    db.commit()

    if os.path.exists(uploads_dir):
        shutil.rmtree(uploads_dir)


def add_file_to_project(
    db: Session,
    project: Project,
    upload: UploadFile,
    *,
    description: Optional[str] = None,
) -> Tuple[ProjectFile, Optional[KMLParseResult], Optional[str]]:
    project_dir = _ensure_project_dir(project.id)

    original_name = upload.filename or "upload"
    extension = os.path.splitext(original_name)[1]
    stored_filename = f"{uuid.uuid4().hex}{extension}"
    destination_path = os.path.join(project_dir, stored_filename)

    upload.file.seek(0)
    with open(destination_path, "wb") as destination:
        shutil.copyfileobj(upload.file, destination)

    file_size = os.path.getsize(destination_path)

    parse_result: Optional[KMLParseResult] = None
    parse_error: Optional[str] = None

    project_file = ProjectFile(
        project_id=project.id,
        original_filename=original_name,
        stored_filename=stored_filename,
        content_type=upload.content_type,
        description=description,
        file_size=file_size,
    )
    db.add(project_file)

    if project.files is not None:
        project.files.append(project_file)
    else:
        project.files = [project_file]

    update_project_required = False

    if original_name.lower().endswith((".kml", ".kmz")):
        try:
            parse_result = parse_kml_file(destination_path)
        except KMLParserError as exc:
            parse_error = str(exc)
            logger.warning("Failed to parse KML for project %s: %s", project.id, exc)
        else:
            overrides = {project_file.stored_filename: parse_result}
            rebuild = _rebuild_project_features_from_kml_files(project, overrides=overrides)
            geometry_updated, poles_updated = apply_rebuilt_features(project, rebuild, allow_clear=False)

            if geometry_updated or poles_updated:
                db.add(project)
                update_project_required = True

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise

    db.refresh(project_file)
    if update_project_required:
        db.refresh(project)

    return project_file, parse_result, parse_error


def delete_project_file(db: Session, project_file: ProjectFile) -> None:
    file_path = os.path.join(_project_upload_root(), str(project_file.project_id), project_file.stored_filename)
    db.delete(project_file)
    db.commit()

    if os.path.exists(file_path):
        os.remove(file_path)


def get_project_file(db: Session, project_id: int, file_id: int) -> Optional[ProjectFile]:
    return (
        db.query(ProjectFile)
        .filter(ProjectFile.project_id == project_id, ProjectFile.id == file_id)
        .first()
    )


def iter_project_files(project: Project) -> Iterable[ProjectFile]:
    return project.files if project.files else []

import json
import logging
import os
from collections import defaultdict
from datetime import datetime
from typing import Dict, Optional

from app.core.config import settings
from app.core.celery_app import celery_app
from app.core.database import SessionLocal
from app.models.classification_edit import ClassificationEditBatch, ClassificationEditStatus

logger = logging.getLogger(__name__)

TASK_NAME = "app.services.classification_worker.process_classification_edit_batch_task"


def enqueue_classification_edit_batch(batch: ClassificationEditBatch) -> None:
    """Enqueue the batch for asynchronous processing."""
    logger.info(
        "Classification edit batch %s queued for point cloud %s (%d points, %d unstable)",
        batch.id,
        batch.pointcloud_id,
        batch.total_points,
        batch.unstable_count,
    )
    celery_app.send_task(
        TASK_NAME,
        args=[batch.id],
        queue=settings.classification_queue,
    )
    logger.info("Dispatched classification batch %s to Celery queue", batch.id)


def process_classification_edit_batch(batch_id: str) -> None:
    """
    Apply classification deltas to point cloud metadata and persist overrides.

    NOTE: This still uses overlay persistence. Replace with real COPC tile editing
    when ready.
    """
    session = SessionLocal()
    batch: Optional[ClassificationEditBatch] = None

    try:
        batch = (
            session.query(ClassificationEditBatch)
            .filter(ClassificationEditBatch.id == batch_id)
            .first()
        )

        if not batch:
            logger.warning("Classification edit batch %s not found", batch_id)
            return

        if batch.status in {ClassificationEditStatus.COMPLETED, ClassificationEditStatus.FAILED}:
            logger.info("Batch %s already finalized (%s); skipping.", batch.id, batch.status)
            return

        batch.status = ClassificationEditStatus.PROCESSING
        batch.tiles_processed = 0
        batch.points_processed = 0
        session.flush()

        logger.info(
            "Processing classification batch %s (point cloud %s)",
            batch.id,
            batch.pointcloud_id,
        )

        pointcloud = batch.pointcloud
        if pointcloud is None:
            logger.error("Batch %s has no associated point cloud", batch.id)
            batch.status = ClassificationEditStatus.FAILED
            batch.error_details = {"message": "Point cloud not found"}
            session.commit()
            return

        classification_counts: Dict[str, int] = defaultdict(int)
        for key, value in (pointcloud.classification or {}).items():
            try:
                classification_counts[str(key)] = max(0, int(value))
            except (TypeError, ValueError):
                logger.debug("Skipping non-numeric classification value for key %s: %s", key, value)

        overrides: Dict[str, Dict[str, int]] = _load_existing_overrides(pointcloud.id)
        deltas: Dict[str, int] = defaultdict(int)
        operations = batch.operations or []
        tiles_total = 0

        for operation in operations:
            new_class = operation.get("newClass")
            previous_class = operation.get("previousClass")
            points = operation.get("points", [])

            if new_class is None or not points:
                continue

            tiles_total += 1
            count = len(points)
            deltas[str(new_class)] += count

            if previous_class is not None and previous_class != new_class:
                deltas[str(previous_class)] -= count

            for point in points:
                tile_key = point.get("tileKey")
                point_index = point.get("pointIndex")
                if tile_key is None or point_index is None:
                    continue
                tile_overrides = overrides.setdefault(str(tile_key), {})
                tile_overrides[str(point_index)] = int(new_class)

            batch.tiles_processed += 1
            batch.points_processed += count
            batch.updated_at = datetime.utcnow()
            session.flush()

        batch.tiles_total = tiles_total

        for class_id, delta in deltas.items():
            classification_counts[class_id] = max(0, classification_counts.get(class_id, 0) + delta)

        pointcloud.classification = {key: int(value) for key, value in classification_counts.items()}

        _persist_overrides(pointcloud.id, overrides)

        batch.status = ClassificationEditStatus.COMPLETED
        batch.completed_at = datetime.utcnow()

        metadata = dict(batch.metadata_payload or {})
        if deltas:
            metadata["deltas"] = {key: int(value) for key, value in deltas.items()}
        metadata["overridesPath"] = _overrides_path(pointcloud.id)
        batch.metadata_payload = metadata or None

        session.commit()
        logger.info(
            "Classification edit batch %s completed with deltas %s (overrides updated)",
            batch.id,
            dict(deltas),
        )
    except Exception as exc:
        session.rollback()
        if batch:
            batch.status = ClassificationEditStatus.FAILED
            batch.error_details = {"message": str(exc)}
            batch.updated_at = datetime.utcnow()
            session.commit()
        logger.exception("Failed to process classification edit batch %s", batch_id)
    finally:
        session.close()


def _overrides_path(pointcloud_id: int) -> str:
    return os.path.join(
        settings.pointcloud_output_dir,
        str(pointcloud_id),
        "classification_overrides.json",
    )


def _load_existing_overrides(pointcloud_id: int) -> Dict[str, Dict[str, int]]:
    path = _overrides_path(pointcloud_id)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                str(tile_key): {str(idx): int(val) for idx, val in tile_map.items()}
                for tile_key, tile_map in data.items()
            }
        except Exception as exc:
            logger.warning("Failed to load existing overrides %s: %s", path, exc)
    return {}


def _persist_overrides(pointcloud_id: int, overrides: Dict[str, Dict[str, int]]) -> None:
    path = _overrides_path(pointcloud_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(overrides, f)
    logger.debug("Persisted classification overrides: %s", path)

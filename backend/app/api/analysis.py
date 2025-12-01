from __future__ import annotations

from datetime import datetime
from pathlib import Path
import shutil
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.database import get_db
from app.models.cluster_job import ClusterGenerationJob, ClusterJobStatus
from app.models.pointcloud import PointCloud
from app.services.cluster_registry import (
    EmbeddingJob,
    ClusterJob,
    get_cluster_job,
    get_overlay_manifest,
    get_overlay_payload,
    list_cluster_jobs,
    list_embedding_jobs,
)


router = APIRouter(prefix="/analysis", tags=["analysis"])


class EmbeddingJobSummaryPayload(BaseModel):
    runName: str
    jobName: str
    createdAt: datetime
    totalEmbeddings: int
    embeddingDim: int
    fileCount: int
    metadataPath: str

    @classmethod
    def from_job(cls, job: EmbeddingJob) -> "EmbeddingJobSummaryPayload":
        meta = job.metadata
        return cls(
            runName=job.run_name,
            jobName=job.job_name,
            createdAt=datetime.fromisoformat(meta["createdAt"].replace("Z", "+00:00")),
            totalEmbeddings=meta["totalEmbeddings"],
            embeddingDim=meta["embeddingDim"],
            fileCount=meta["fileCount"],
            metadataPath=str(job.metadata_path),
        )


class ClusterJobSummaryPayload(BaseModel):
    runName: str
    jobName: str
    createdAt: datetime
    clusters: int
    inertia: float
    iterations: int
    summaryPath: str
    hasOverlays: bool

    @classmethod
    def from_job(cls, job: ClusterJob) -> "ClusterJobSummaryPayload":
        summary = job.summary
        return cls(
            runName=job.run_name,
            jobName=job.job_name,
            createdAt=datetime.fromisoformat(summary["createdAt"].replace("Z", "+00:00")),
            clusters=summary["clusters"],
            inertia=summary["inertia"],
            iterations=summary["iterations"],
            summaryPath=str(job.summary_path),
            hasOverlays=bool(job.overlay_manifest),
        )


class ClusterOverlaySummaryPayload(BaseModel):
    pointcloudId: int
    overlayName: str
    pointCount: int
    tileCount: int
    clusterCounts: dict


class ClusterOverlayPayload(BaseModel):
    pointcloudId: int
    runName: str
    clusterJob: str
    filePath: str
    overrides: dict
    clusterCounts: dict
    tileCount: int
    pointCount: int


class ClusterJobDetailPayload(BaseModel):
    runName: str
    jobName: str
    createdAt: datetime
    clusters: int
    inertia: float
    iterations: int
    counts: List[dict]
    fileCounts: List[dict]
    embeddingsFile: str
    overlays: Optional[List[ClusterOverlaySummaryPayload]] = None

    @classmethod
    def from_job(cls, job: ClusterJob) -> "ClusterJobDetailPayload":
        summary = job.summary
        overlays = None
        if job.overlay_manifest:
            overlays = job.overlay_manifest.get("pointclouds", [])

        return cls(
            runName=job.run_name,
            jobName=job.job_name,
            createdAt=datetime.fromisoformat(summary["createdAt"].replace("Z", "+00:00")),
            clusters=summary["clusters"],
            inertia=summary["inertia"],
            iterations=summary["iterations"],
            counts=summary.get("counts", []),
            fileCounts=summary.get("fileCounts", []),
            embeddingsFile=summary["embeddingsFile"],
            overlays=overlays,
        )


@router.get("/embedding-jobs", response_model=List[EmbeddingJobSummaryPayload])
def list_embedding_job_summaries() -> List[EmbeddingJobSummaryPayload]:
    jobs = list_embedding_jobs()
    return [EmbeddingJobSummaryPayload.from_job(job) for job in jobs]


@router.get("/cluster-jobs", response_model=List[ClusterJobSummaryPayload])
def list_cluster_job_summaries() -> List[ClusterJobSummaryPayload]:
    jobs = list_cluster_jobs()
    return [ClusterJobSummaryPayload.from_job(job) for job in jobs]


@router.get("/cluster-jobs/{run_name}/{job_name}", response_model=ClusterJobDetailPayload)
def get_cluster_job_detail(run_name: str, job_name: str) -> ClusterJobDetailPayload:
    job = get_cluster_job(run_name, job_name)
    if not job:
        raise HTTPException(status_code=404, detail="Cluster job not found.")
    return ClusterJobDetailPayload.from_job(job)


@router.get("/cluster-jobs/{run_name}/{job_name}/overlays")
def list_cluster_overlays(run_name: str, job_name: str) -> dict:
    manifest = get_overlay_manifest(run_name, job_name)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Overlay manifest not found.")
    return manifest


@router.get("/cluster-jobs/{run_name}/{job_name}/overlays/{overlay_name}", response_model=ClusterOverlayPayload)
def get_cluster_overlay(run_name: str, job_name: str, overlay_name: str) -> ClusterOverlayPayload:
    payload = get_overlay_payload(run_name, job_name, overlay_name)
    if payload is None:
        raise HTTPException(status_code=404, detail="Overlay payload not found.")
    return ClusterOverlayPayload(**payload)


# Cluster generation job endpoints
class CreateClusterJobRequest(BaseModel):
    numClusters: int = 12
    maxTrainingSteps: int = 2000
    patchesPerFile: Optional[int] = None  # Optional: explicit patch count
    checkpointPath: Optional[str] = None  # If provided, skip training and use this model
    targetCoverage: Optional[int] = None  # Target coverage percentage (25, 50, 90, etc.)


class ClusterGenerationJobResponse(BaseModel):
    id: str
    pointcloudId: int
    status: str
    runName: str
    clusterJobName: Optional[str]
    numClusters: int
    maxTrainingSteps: int
    currentStep: int
    totalSteps: Optional[int]
    progressMessage: Optional[str]
    overlayPath: Optional[str]
    errorDetails: Optional[dict]
    workerTaskId: Optional[str]
    receivedAt: datetime
    updatedAt: datetime
    completedAt: Optional[datetime]

    @classmethod
    def from_model(cls, job: ClusterGenerationJob) -> "ClusterGenerationJobResponse":
        return cls(
            id=job.id,
            pointcloudId=job.pointcloud_id,
            status=job.status.value,
            runName=job.run_name,
            clusterJobName=job.cluster_job_name,
            numClusters=job.num_clusters,
            maxTrainingSteps=job.max_training_steps,
            currentStep=job.current_step,
            totalSteps=job.total_steps,
            progressMessage=job.progress_message,
            overlayPath=job.overlay_path,
            errorDetails=job.error_details,
            workerTaskId=job.worker_task_id,
            receivedAt=job.received_at,
            updatedAt=job.updated_at,
            completedAt=job.completed_at,
        )


@router.post("/pointclouds/{pointcloud_id}/generate-clusters", response_model=ClusterGenerationJobResponse)
def create_cluster_generation_job(
    pointcloud_id: int,
    request: CreateClusterJobRequest,
    db: Session = Depends(get_db),
) -> ClusterGenerationJobResponse:
    """Trigger cluster generation for a specific point cloud."""
    # Verify point cloud exists
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    # Check if there's already an active job for this point cloud
    active_statuses = [
        ClusterJobStatus.QUEUED,
        ClusterJobStatus.TRAINING,
        ClusterJobStatus.EXTRACTING,
        ClusterJobStatus.CLUSTERING,
        ClusterJobStatus.BUILDING_OVERLAY,
    ]
    existing_job = (
        db.query(ClusterGenerationJob)
        .filter(
            ClusterGenerationJob.pointcloud_id == pointcloud_id,
            ClusterGenerationJob.status.in_(active_statuses)
        )
        .first()
    )

    if existing_job:
        raise HTTPException(
            status_code=409,
            detail=f"A clustering job is already running for this point cloud (Job ID: {existing_job.id}, Status: {existing_job.status.value})"
        )

    # Create a unique run name based on point cloud and timestamp
    run_name = f"pc{pointcloud_id}-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"

    # Calculate patches based on target coverage if not explicitly provided
    patches_per_file = request.patchesPerFile
    if not patches_per_file and request.targetCoverage:
        # Calculate patches needed for target coverage
        # Formula: (point_count / 512) * (target_coverage / 100) * 1.5 (overlap factor)
        point_count = pointcloud.point_count or 0
        if point_count > 0:
            patch_size = 512
            patches_per_file = int((point_count / patch_size) * (request.targetCoverage / 100.0) * 1.5)
            patches_per_file = min(patches_per_file, 1_000_000)  # Cap at 1M

    # Create the job record
    job = ClusterGenerationJob(
        pointcloud_id=pointcloud_id,
        run_name=run_name,
        num_clusters=request.numClusters,
        max_training_steps=request.maxTrainingSteps,
        patches_per_file=patches_per_file,
        checkpoint_path=request.checkpointPath,
        status=ClusterJobStatus.QUEUED,
        progress_message="Queued for processing..." if not request.checkpointPath else "Queued (using existing model)...",
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Queue the Celery task (using celery_app.send_task like classification worker)
    celery_app.send_task(
        "app.services.clustering_worker.generate_clusters_task",
        args=[job.id],
    )

    return ClusterGenerationJobResponse.from_model(job)


@router.get("/pointclouds/{pointcloud_id}/cluster-jobs", response_model=List[ClusterGenerationJobResponse])
def list_pointcloud_cluster_jobs(
    pointcloud_id: int,
    db: Session = Depends(get_db),
) -> List[ClusterGenerationJobResponse]:
    """List all cluster generation jobs for a specific point cloud."""
    jobs = (
        db.query(ClusterGenerationJob)
        .filter(ClusterGenerationJob.pointcloud_id == pointcloud_id)
        .order_by(ClusterGenerationJob.received_at.desc())
        .all()
    )
    return [ClusterGenerationJobResponse.from_model(job) for job in jobs]


@router.get("/cluster-generation-jobs/{job_id}", response_model=ClusterGenerationJobResponse)
def get_cluster_generation_job(
    job_id: str,
    db: Session = Depends(get_db),
) -> ClusterGenerationJobResponse:
    """Get status and details of a cluster generation job."""
    job = db.query(ClusterGenerationJob).filter(ClusterGenerationJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Cluster generation job not found")
    return ClusterGenerationJobResponse.from_model(job)


class TrainedModelResponse(BaseModel):
    runName: str
    checkpointPath: str
    createdAt: datetime
    configPath: Optional[str] = None
    config: Optional[dict] = None  # Training configuration/stats
    trainingGraphs: Optional[dict] = None  # Training visualization graphs


@router.get("/trained-models", response_model=List[TrainedModelResponse])
def list_trained_models() -> List[TrainedModelResponse]:
    """List all available trained encoder models."""
    # Get upload directory - in Docker it's mounted at /app/uploads
    upload_base = Path(settings.upload_dir)
    if not upload_base.is_absolute():
        upload_base = Path("/app") / upload_base

    models_dir = upload_base / "cluster_models"

    if not models_dir.exists():
        return []

    models = []
    try:
        import json
        for run_dir in models_dir.iterdir():
            if not run_dir.is_dir():
                continue

            checkpoint = run_dir / "latest.pt"
            if not checkpoint.exists():
                continue

            config_path = run_dir / "config.json"
            created_at = datetime.fromtimestamp(checkpoint.stat().st_mtime)

            # Load config if it exists
            config_data = None
            if config_path.exists():
                try:
                    with open(config_path, "r") as f:
                        config_data = json.load(f)
                except Exception as e:
                    print(f"Error reading config for {run_dir.name}: {e}")

            # Look for training graph PNGs
            training_graphs = {}
            graph_names = ['loss', 'lr', 'delta', 'best']
            for graph_name in graph_names:
                graph_file = run_dir / f"{run_dir.name}-{graph_name}.png"
                if graph_file.exists():
                    # Return relative path from uploads directory for API serving
                    training_graphs[graph_name] = f"/uploads/cluster_models/{run_dir.name}/{graph_file.name}"

            models.append(
                TrainedModelResponse(
                    runName=run_dir.name,
                    checkpointPath=str(checkpoint.absolute()),
                    createdAt=created_at,
                    configPath=str(config_path.absolute()) if config_path.exists() else None,
                    config=config_data,
                    trainingGraphs=training_graphs if training_graphs else None,
                )
            )
    except Exception as e:
        print(f"Error listing trained models: {e}")
        return []

    # Sort by creation time, newest first
    models.sort(key=lambda m: m.createdAt, reverse=True)
    return models


def _resolve_upload_base() -> Path:
    upload_base = Path(settings.upload_dir)
    if not upload_base.is_absolute():
        upload_base = Path("/app") / upload_base
    return upload_base


def _delete_job_artifacts(job: ClusterGenerationJob) -> None:
    upload_base = _resolve_upload_base()
    run_dir = upload_base / "cluster_models" / job.run_name
    if run_dir.exists():
        shutil.rmtree(run_dir, ignore_errors=True)


@router.post("/cluster-generation-jobs/{job_id}/cancel", response_model=ClusterGenerationJobResponse)
def cancel_cluster_generation_job(
    job_id: str,
    db: Session = Depends(get_db),
) -> ClusterGenerationJobResponse:
    job = db.query(ClusterGenerationJob).filter(ClusterGenerationJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Cluster generation job not found")

    if job.status in {ClusterJobStatus.COMPLETED, ClusterJobStatus.FAILED, ClusterJobStatus.CANCELLED}:
        raise HTTPException(status_code=409, detail="Job is already finished and cannot be cancelled.")

    if job.worker_task_id:
        celery_app.control.revoke(job.worker_task_id, terminate=True, signal="SIGTERM")

    job.status = ClusterJobStatus.CANCELLED
    job.progress_message = "Cluster generation cancelled by user."
    job.completed_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return ClusterGenerationJobResponse.from_model(job)


@router.delete("/cluster-generation-jobs/{job_id}", response_model=ClusterGenerationJobResponse)
def delete_cluster_generation_job(
    job_id: str,
    db: Session = Depends(get_db),
) -> ClusterGenerationJobResponse:
    job = db.query(ClusterGenerationJob).filter(ClusterGenerationJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Cluster generation job not found")

    if job.status not in {ClusterJobStatus.COMPLETED, ClusterJobStatus.FAILED, ClusterJobStatus.CANCELLED}:
        raise HTTPException(status_code=400, detail="Cancel the job before deleting it.")

    response = ClusterGenerationJobResponse.from_model(job)
    _delete_job_artifacts(job)
    db.delete(job)
    db.commit()
    return response

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.config import settings


def _runs_root() -> Path:
    return Path(settings.upload_dir).resolve() / "cluster_models"


def _load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text())


@dataclass
class EmbeddingJob:
    run_name: str
    job_name: str
    metadata_path: Path
    metadata: Dict[str, Any]


@dataclass
class ClusterJob:
    run_name: str
    job_name: str
    summary_path: Path
    summary: Dict[str, Any]
    overlay_manifest: Optional[Dict[str, Any]] = None


def list_embedding_jobs() -> List[EmbeddingJob]:
    jobs: List[EmbeddingJob] = []
    root = _runs_root()
    if not root.exists():
        return jobs
    for run_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        embeddings_dir = run_dir / "embeddings"
        if not embeddings_dir.exists():
            continue
        for job_dir in sorted(p for p in embeddings_dir.iterdir() if p.is_dir()):
            metadata_path = job_dir / "metadata.json"
            if not metadata_path.exists():
                continue
            jobs.append(
                EmbeddingJob(
                    run_name=run_dir.name,
                    job_name=job_dir.name,
                    metadata_path=metadata_path,
                    metadata=_load_json(metadata_path),
                )
            )
    return jobs


def list_cluster_jobs() -> List[ClusterJob]:
    jobs: List[ClusterJob] = []
    root = _runs_root()
    if not root.exists():
        return jobs
    for run_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        clusters_dir = run_dir / "clusters"
        if not clusters_dir.exists():
            continue
        for job_dir in sorted(p for p in clusters_dir.iterdir() if p.is_dir()):
            summary_path = job_dir / "summary.json"
            if not summary_path.exists():
                continue
            manifest_path = job_dir / "overlays" / "manifest.json"
            overlay_manifest = _load_json(manifest_path) if manifest_path.exists() else None
            jobs.append(
                ClusterJob(
                    run_name=run_dir.name,
                    job_name=job_dir.name,
                    summary_path=summary_path,
                    summary=_load_json(summary_path),
                    overlay_manifest=overlay_manifest,
                )
            )
    return jobs


def get_cluster_job(run_name: str, job_name: str) -> Optional[ClusterJob]:
    root = _runs_root()
    summary_path = root / run_name / "clusters" / job_name / "summary.json"
    if not summary_path.exists():
        return None
    manifest_path = summary_path.parent / "overlays" / "manifest.json"
    overlay_manifest = _load_json(manifest_path) if manifest_path.exists() else None
    return ClusterJob(
        run_name=run_name,
        job_name=job_name,
        summary_path=summary_path,
        summary=_load_json(summary_path),
        overlay_manifest=overlay_manifest,
    )


def get_overlay_manifest(run_name: str, job_name: str) -> Optional[Dict[str, Any]]:
    manifest_path = _runs_root() / run_name / "clusters" / job_name / "overlays" / "manifest.json"
    if not manifest_path.exists():
        return None
    return _load_json(manifest_path)


def get_overlay_payload(run_name: str, job_name: str, overlay_name: str) -> Optional[Dict[str, Any]]:
    overlay_path = _runs_root() / run_name / "clusters" / job_name / "overlays" / overlay_name
    if not overlay_path.exists():
        return None
    return _load_json(overlay_path)


__all__ = [
    "EmbeddingJob",
    "ClusterJob",
    "list_embedding_jobs",
    "list_cluster_jobs",
    "get_cluster_job",
    "get_overlay_manifest",
    "get_overlay_payload",
]

"""Celery worker for generating clusters on individual point clouds."""
import json
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict

import laspy
import numpy as np
from celery import shared_task
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.cluster_job import ClusterGenerationJob, ClusterJobStatus
from app.models.pointcloud import PointCloud
from app.services.cluster_algorithms import run_minibatch_kmeans, run_standard_kmeans
from app.services.embedding_extractor import EmbeddingExtractionConfig, EmbeddingExtractor
from app.services.self_supervised_training import SelfSupervisedPointNetTrainer, TrainingConfig


class JobCancelledError(Exception):
    """Raised when a user-initiated cancellation is detected."""


def _standardize_features(data: np.ndarray) -> np.ndarray:
    mean = data.mean(axis=0)
    std = data.std(axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    return (data - mean) / std


def _combine_semantic_features(npz: np.lib.npyio.NpzFile) -> tuple[np.ndarray, list[str]]:
    embeddings = np.asarray(npz["embeddings"], dtype=np.float32)
    feature_keys: list[str] = []

    if "geometric_features" in npz:
        geom = np.asarray(npz["geometric_features"], dtype=np.float32)
        if geom.size and geom.shape[0] == embeddings.shape[0]:
            emb_norm = _standardize_features(embeddings)
            geom_norm = _standardize_features(geom)
            embeddings = np.concatenate([emb_norm, geom_norm], axis=1)
            if "geometric_feature_keys" in npz:
                feature_keys = [str(key) for key in np.asarray(npz["geometric_feature_keys"])]

    return embeddings, feature_keys


def compute_cluster_centers(las_path: Path) -> Dict[int, np.ndarray]:
    """
    Compute 3D centroids for each cluster from already-assigned points.

    Uses streaming/chunked processing to avoid loading entire file into memory.

    Args:
        las_path: Path to LAS file with UserData containing cluster IDs

    Returns:
        Dictionary mapping cluster_id -> [x, y, z] centroid
    """
    print(f"📊 Computing cluster centers from {las_path}")

    # Use streaming reader to avoid loading entire file into memory
    with laspy.open(las_path) as las_file:
        # First pass: find unique clusters
        print("First pass: finding unique clusters...")
        unique_clusters_set = set()
        chunk_size = 10_000_000  # Process 10M points at a time

        for points in las_file.chunk_iterator(chunk_size):
            user_data = np.array(points.user_data)
            unique_in_chunk = np.unique(user_data)
            unique_clusters_set.update(unique_in_chunk[unique_in_chunk != 255])

        unique_clusters = sorted(unique_clusters_set)
        print(f"Found {len(unique_clusters)} unique clusters")

        # Second pass: accumulate sums and counts for each cluster
        print("Second pass: computing centroids...")
        cluster_sums = {int(cid): np.zeros(3, dtype=np.float64) for cid in unique_clusters}
        cluster_counts = {int(cid): 0 for cid in unique_clusters}

        for points in las_file.chunk_iterator(chunk_size):
            user_data = np.array(points.user_data)
            xyz = np.vstack([points.x, points.y, points.z]).T

            for cluster_id in unique_clusters:
                mask = user_data == cluster_id
                count = np.sum(mask)
                if count > 0:
                    cluster_sums[int(cluster_id)] += np.sum(xyz[mask], axis=0)
                    cluster_counts[int(cluster_id)] += count

    # Compute centroids
    cluster_centers = {}
    for cluster_id in unique_clusters:
        if cluster_counts[int(cluster_id)] > 0:
            centroid = cluster_sums[int(cluster_id)] / cluster_counts[int(cluster_id)]
            cluster_centers[int(cluster_id)] = centroid
            print(f"  Cluster {cluster_id}: {cluster_counts[int(cluster_id)]:,} points, center at {centroid}")

    print(f"✅ Computed {len(cluster_centers)} cluster centers")
    return cluster_centers


def assign_unassigned_points(
    las_path: Path,
    cluster_centers: Dict[int, np.ndarray],
    batch_size: int = 1_000_000
) -> None:
    """
    Assign all unassigned points (UserData=255) to nearest cluster center.

    Uses chunked reading to minimize memory usage for large point clouds.

    Args:
        las_path: Path to LAS file
        cluster_centers: Dictionary mapping cluster_id -> [x, y, z] centroid
        batch_size: Number of points to process at once (for distance computation)
    """
    print(f"🎯 Assigning unassigned points to nearest clusters...")

    # Get cluster IDs and centers as arrays
    cluster_ids = np.array(list(cluster_centers.keys()))
    centers = np.array(list(cluster_centers.values()))
    print(f"Assigning to {len(cluster_ids)} clusters...")

    # First pass: collect unassigned point indices and coordinates in chunks
    print("First pass: finding unassigned points...")
    unassigned_data = []  # List of (global_index, x, y, z) tuples
    chunk_size = 10_000_000
    global_offset = 0
    total_points = 0

    with laspy.open(las_path) as las_file:
        for points in las_file.chunk_iterator(chunk_size):
            total_points += len(points.points)
            user_data = np.array(points.user_data)
            unassigned_mask = user_data == 255

            if np.any(unassigned_mask):
                xyz = np.vstack([points.x, points.y, points.z]).T
                unassigned_xyz = xyz[unassigned_mask]
                # Store global indices for these unassigned points
                local_indices = np.where(unassigned_mask)[0]
                global_indices = local_indices + global_offset

                for idx, coords in zip(global_indices, unassigned_xyz):
                    unassigned_data.append((idx, coords[0], coords[1], coords[2]))

            global_offset += len(points.points)

    unassigned_count = len(unassigned_data)
    if unassigned_count == 0:
        print("✅ No unassigned points found")
        return

    print(f"Found {unassigned_count:,} unassigned points ({unassigned_count/total_points*100:.1f}%)")

    # Second pass: assign clusters in batches
    print("Second pass: assigning clusters...")
    assignments = {}  # Maps global_index -> cluster_id
    total_assigned = 0

    for i in range(0, unassigned_count, batch_size):
        batch = unassigned_data[i:i + batch_size]
        batch_indices = [item[0] for item in batch]
        batch_coords = np.array([[item[1], item[2], item[3]] for item in batch])

        # Compute distances to all cluster centers for this batch
        distances = np.linalg.norm(
            batch_coords[:, np.newaxis, :] - centers[np.newaxis, :, :],
            axis=2
        )

        # Find nearest cluster for each point
        nearest_cluster_indices = np.argmin(distances, axis=1)
        nearest_cluster_ids = cluster_ids[nearest_cluster_indices]

        # Store assignments
        for idx, cluster_id in zip(batch_indices, nearest_cluster_ids):
            assignments[idx] = cluster_id

        total_assigned += len(batch)

        if (i // batch_size) % 10 == 0:
            print(f"  Progress: {total_assigned:,} / {unassigned_count:,} points ({total_assigned/unassigned_count*100:.1f}%)")

    # Third pass: read file, update UserData, write back in chunks
    print("Third pass: writing updated clusters to file...")
    # We need to read the whole file to update it, but we'll do it more carefully
    las = laspy.read(las_path)
    user_data = np.array(las.user_data)

    # Apply assignments
    for global_idx, cluster_id in assignments.items():
        user_data[global_idx] = cluster_id

    las.user_data = user_data
    las.write(las_path)

    print(f"✅ Assigned {total_assigned:,} points via spatial propagation")

    # Print final statistics
    for cluster_id in cluster_ids:
        count = np.sum(user_data == cluster_id)
        print(f"  Cluster {cluster_id}: {count:,} points")


def write_clusters_to_las(
    las_path: Path,
    labels_file: Path,
    provenance_file: Path,
    pointcloud_id: int,
) -> None:
    """
    Write cluster IDs to the LAS file's UserData field.

    Args:
        las_path: Path to the original LAS file
        labels_file: Path to labels.npy with cluster assignments
        provenance_file: Path to patch_provenance.jsonl mapping patches to points
        pointcloud_id: ID of the point cloud (unused but kept for compatibility)
    """
    print(f"📝 Writing cluster IDs to {las_path}")

    # Load cluster labels
    labels = np.load(labels_file)
    print(f"Loaded {len(labels)} cluster labels")

    # Load provenance mapping (embedding index -> point indices)
    provenance: Dict[int, dict] = {}
    with provenance_file.open() as f:
        for line in f:
            if not line.strip():
                continue
            record = json.loads(line.strip())
            provenance[int(record["embeddingIndex"])] = record

    print(f"Loaded provenance for {len(provenance)} patches")

    # Read the LAS file
    print("Reading LAS file...")
    las = laspy.read(las_path)
    point_count = len(las.points)
    print(f"LAS file has {point_count:,} points")

    # Initialize UserData field with 255 (unclassified)
    user_data = np.full(point_count, 255, dtype=np.uint8)

    # Collect votes for overlapping patches (majority voting)
    from collections import defaultdict, Counter
    point_votes: Dict[int, list] = defaultdict(list)

    print("Collecting cluster votes from overlapping patches...")
    for emb_idx, cluster_id in enumerate(labels):
        patch_info = provenance.get(emb_idx)
        if not patch_info:
            continue

        point_indices = patch_info.get("pointIndices", [])
        for point_idx in point_indices:
            if 0 <= point_idx < point_count:
                point_votes[point_idx].append(int(cluster_id))

    # Assign clusters using majority voting
    print("Applying majority voting for cluster assignment...")
    points_assigned = 0
    multi_vote_count = 0

    for point_idx, votes in point_votes.items():
        # Use most common vote (majority wins)
        cluster_id = Counter(votes).most_common(1)[0][0]
        user_data[point_idx] = cluster_id
        points_assigned += 1

        # Track how many points had multiple votes (overlapping patches)
        if len(votes) > 1:
            multi_vote_count += 1

    overlap_pct = (multi_vote_count / max(points_assigned, 1)) * 100
    print(f"Assigned cluster IDs to {points_assigned:,} points ({points_assigned/point_count*100:.1f}%)")
    print(f"  Points with overlapping patches: {multi_vote_count:,} ({overlap_pct:.1f}%)")

    # Write UserData to LAS file
    las.user_data = user_data
    las.write(las_path)
    print(f"✅ Cluster IDs written to {las_path}")



@shared_task(
    name="app.services.clustering_worker.generate_clusters_task",
    bind=True,
    time_limit=21600,
)
def generate_clusters_task(self, job_id: str) -> None:
    """Run the end-to-end clustering pipeline for a point cloud."""
    db: Session = SessionLocal()
    temp_dir: Path | None = None
    job = None

    def update_progress(*, status=None, current=None, total=None, message=None) -> None:
        if not job:
            return
        if status is not None:
            job.status = status
        if current is not None:
            job.current_step = current
        if total is not None:
            job.total_steps = total
        if message is not None:
            job.progress_message = message
        job.updated_at = datetime.utcnow()
        db.commit()

    def ensure_not_cancelled() -> None:
        if not job:
            return
        db.refresh(job)
        if job.status == ClusterJobStatus.CANCELLED:
            raise JobCancelledError("Cluster generation job was cancelled by user")

    try:
        job = db.query(ClusterGenerationJob).filter(ClusterGenerationJob.id == job_id).first()
        if not job:
            raise ValueError(f"Cluster job {job_id} not found")

        job.worker_task_id = getattr(self.request, "id", None)
        db.commit()

        pointcloud = db.query(PointCloud).filter(PointCloud.id == job.pointcloud_id).first()
        if not pointcloud:
            raise ValueError(f"PointCloud {job.pointcloud_id} not found")

        parent_dir = Path(settings.pointcloud_output_dir)
        if not parent_dir.is_absolute():
            parent_dir = (Path("/app") / parent_dir).resolve()

        pointcloud_subdir = parent_dir / str(pointcloud.id)
        original_filename = pointcloud.original_filename or f"{pointcloud.name}.las"
        original_las_path = (parent_dir / original_filename).resolve()

        if original_las_path.exists():
            temp_dir = Path(tempfile.mkdtemp(prefix=f"pointcloud_{pointcloud.id}_"))
            copy_target = temp_dir / original_filename
            link_method = None
            try:
                copy_target.symlink_to(original_las_path)
                link_method = "symlink"
            except (OSError, NotImplementedError):
                try:
                    copy_target.hardlink_to(original_las_path)
                    link_method = "hardlink"
                except (OSError, NotImplementedError):
                    shutil.copy2(original_las_path, copy_target)
                    link_method = "copy"

            if not copy_target.exists():
                raise FileNotFoundError(f"Failed to prepare temporary LAS file at {copy_target}")

            update_progress(message=f"Using {link_method}: {copy_target}")
            pointcloud_dir = copy_target.parent
        elif pointcloud_subdir.exists():
            pointcloud_dir = pointcloud_subdir
        else:
            raise FileNotFoundError(f"Point cloud file not found: {original_las_path}")

        point_count = pointcloud.point_count or 0
        if point_count > 10_000_000 and job.patches_per_file:
            patch_size = 512
            estimated_coverage = (job.patches_per_file * patch_size) / (point_count * 1.5) * 100
            estimated_time_min = (job.patches_per_file / 1000) * 0.2
            if estimated_coverage < 50:
                update_progress(
                    message=f"Fast mode: {job.patches_per_file:,} patches (~{int(estimated_time_min + 30)} min with spatial propagation)"
                )
            else:
                update_progress(
                    message=f"Using {job.patches_per_file:,} patches (est. {estimated_coverage:.0f}% coverage, ~{int(estimated_time_min + 20)} min)"
                )

        repo_root = Path(__file__).resolve().parents[2]
        upload_base = Path(settings.upload_dir)
        if not upload_base.is_absolute():
            upload_base = (repo_root / upload_base).resolve()
        output_dir = upload_base / "cluster_models"

        checkpoint_path = Path(job.checkpoint_path) if job.checkpoint_path else None
        if checkpoint_path and not checkpoint_path.exists():
            raise FileNotFoundError(f"Provided checkpoint not found at {checkpoint_path}")

        if not checkpoint_path:
            ensure_not_cancelled()
            update_progress(
                status=ClusterJobStatus.TRAINING,
                current=0,
                total=job.max_training_steps,
                message="Training self-supervised encoder...",
            )

            training_config = TrainingConfig(
                pointcloud_dir=pointcloud_dir,
                output_dir=output_dir,
                run_name=job.run_name,
                patches_per_file=job.patches_per_file or 2048,
                patch_size=512,
                batch_size=32,
                max_steps=job.max_training_steps,
                num_workers=2,
            )
            trainer = SelfSupervisedPointNetTrainer(training_config)

            def training_callback(step: int, total: int, loss: float) -> None:
                ensure_not_cancelled()
                update_progress(
                    current=step,
                    total=total,
                    message=f"Training encoder: step {step}/{total} (loss {loss:.4f})",
                )

            trainer.train(progress_callback=training_callback)
            checkpoint_path = trainer.run_dir / "latest.pt"
            if not checkpoint_path.exists():
                raise FileNotFoundError(f"Checkpoint not found at {checkpoint_path}")

            job.checkpoint_path = str(checkpoint_path)
            db.commit()

        ensure_not_cancelled()

        emb_job_name = f"{job.run_name}-embedding"
        emb_output_dir = output_dir / job.run_name / "embeddings"
        extraction_config = EmbeddingExtractionConfig(
            checkpoint_path=checkpoint_path,
            pointcloud_dir=pointcloud_dir,
            output_dir=emb_output_dir,
            job_name=emb_job_name,
            patches_per_file=job.patches_per_file or 2048,
            batch_size=64,
            num_workers=0,
        )
        extractor = EmbeddingExtractor(extraction_config)
        update_progress(
            status=ClusterJobStatus.EXTRACTING,
            current=0,
            total=extraction_config.patches_per_file,
            message="Extracting embeddings...",
        )

        def embedding_callback(processed: int, total: int, message: str) -> None:
            ensure_not_cancelled()
            update_progress(current=min(processed, total), total=total, message=message)

        embeddings_file = extractor.extract(progress_callback=embedding_callback)
        if not embeddings_file.exists():
            raise FileNotFoundError(f"Embeddings file not found at {embeddings_file}")

        job.embedding_path = str(embeddings_file)
        db.commit()

        ensure_not_cancelled()

        cluster_job_name = job.cluster_job_name or f"{job.run_name}-k{job.num_clusters}"
        clusters_dir = output_dir / job.run_name / "clusters" / cluster_job_name
        clusters_dir.mkdir(parents=True, exist_ok=True)

        npz = np.load(embeddings_file, allow_pickle=False)
        embeddings, geom_feature_keys = _combine_semantic_features(npz)
        file_indices = npz["file_indices"]
        file_paths = npz["file_paths"]
        feature_source = "embedding+geometric" if geom_feature_keys else "embedding"
        feature_dim = embeddings.shape[1]
        if geom_feature_keys:
            update_progress(
                message=f"Using semantic features ({feature_source}) with {len(geom_feature_keys)} handcrafted dims",
            )

        max_iter = 100
        tol = 1e-4
        update_progress(
            status=ClusterJobStatus.CLUSTERING,
            current=0,
            total=max_iter,
            message="Running K-Means clustering...",
        )

        def clustering_callback(iteration: int, total: int, message: str) -> None:
            ensure_not_cancelled()
            update_progress(current=min(iteration, total), total=total, message=f"Clustering: {message}")

        if embeddings.shape[0] > 100_000:
            centroids, labels, inertia, iterations = run_minibatch_kmeans(
                embeddings,
                job.num_clusters,
                max_iter,
                tol,
                seed=42,
                progress_callback=clustering_callback,
            )
        else:
            centroids, labels, inertia, iterations = run_standard_kmeans(
                embeddings,
                job.num_clusters,
                max_iter,
                tol,
                seed=42,
                progress_callback=clustering_callback,
            )

        np.save(clusters_dir / "labels.npy", labels)
        np.save(clusters_dir / "centroids.npy", centroids)

        # Compute confidence scores (distance to assigned cluster center)
        print("Computing confidence scores...")
        distances_to_cluster = np.linalg.norm(
            embeddings - centroids[labels],
            axis=1
        )
        confidence_scores = 1.0 / (1.0 + distances_to_cluster)
        np.save(clusters_dir / "confidence_scores.npy", confidence_scores)

        # Compute statistics
        avg_confidence = float(np.mean(confidence_scores))
        low_confidence_count = int(np.sum(confidence_scores < 0.5))
        low_confidence_pct = (low_confidence_count / len(confidence_scores)) * 100

        print(f"  Average confidence: {avg_confidence:.3f}")
        print(f"  Low confidence patches (<0.5): {low_confidence_count:,} ({low_confidence_pct:.1f}%)")

        counts: Dict[int, int] = {}
        for label in labels:
            counts[int(label)] = counts.get(int(label), 0) + 1

        file_counts: Dict[str, int] = {}
        for idx in file_indices:
            path = str(file_paths[idx])
            file_counts[path] = file_counts.get(path, 0) + 1

        summary = {
            "jobName": cluster_job_name,
            "createdAt": datetime.utcnow().isoformat() + "Z",
            "embeddingsFile": str(embeddings_file),
            "outputDir": str(clusters_dir),
            "clusters": job.num_clusters,
            "maxIter": max_iter,
            "iterations": iterations,
            "tol": tol,
            "seed": 42,
            "inertia": inertia,
            "featureSource": feature_source,
            "featureDim": feature_dim,
            "geometricFeatureKeys": geom_feature_keys,
            "confidenceStats": {
                "average": avg_confidence,
                "lowConfidenceCount": low_confidence_count,
                "lowConfidencePercentage": low_confidence_pct,
            },
            "counts": [{"cluster": k, "count": v} for k, v in sorted(counts.items())],
            "fileCounts": [{"filePath": path, "count": count} for path, count in sorted(file_counts.items())],
        }
        (clusters_dir / "summary.json").write_text(json.dumps(summary, indent=2))

        job.cluster_job_name = cluster_job_name
        job.metrics = {
            "inertia": inertia,
            "iterations": iterations,
            "featureSource": feature_source,
            "featureDim": feature_dim,
        }
        db.commit()

        labels_file = clusters_dir / "labels.npy"
        provenance_file = emb_output_dir / emb_job_name / "patch_provenance.jsonl"
        overlay_steps = 4
        update_progress(
            status=ClusterJobStatus.BUILDING_OVERLAY,
            current=0,
            total=overlay_steps,
            message="Writing cluster IDs to LAS file...",
        )

        if labels_file.exists() and provenance_file.exists():
            try:
                write_clusters_to_las(
                    las_path=original_las_path,
                    labels_file=labels_file,
                    provenance_file=provenance_file,
                    pointcloud_id=pointcloud.id,
                )
                update_progress(
                    current=1,
                    total=overlay_steps,
                    message="Cluster assignments written. Checking coverage...",
                )

                with laspy.open(original_las_path) as las_file:
                    total_points = 0
                    assigned_points = 0
                    for points in las_file.chunk_iterator(10_000_000):
                        user_data = np.array(points.user_data)
                        total_points += len(user_data)
                        assigned_points += np.sum(user_data != 255)

                coverage_pct = (assigned_points / total_points) * 100 if total_points > 0 else 0
                print(f"Cluster coverage: {assigned_points:,} / {total_points:,} points ({coverage_pct:.1f}%)")

                if coverage_pct < 90.0:
                    update_progress(
                        current=2,
                        total=overlay_steps,
                        message=f"Coverage {coverage_pct:.1f}% - propagating to {total_points - assigned_points:,} remaining points...",
                    )
                    cluster_centers = compute_cluster_centers(original_las_path)
                    assign_unassigned_points(original_las_path, cluster_centers)
                else:
                    update_progress(
                        current=2,
                        total=overlay_steps,
                        message=f"High coverage ({coverage_pct:.1f}%) - skipping spatial propagation",
                    )

                update_progress(
                    current=3,
                    total=overlay_steps,
                    message="Reconverting point cloud with cluster data...",
                )
                from app.services.pointcloud_processor import PointCloudProcessor
                import asyncio

                processor = PointCloudProcessor()
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                success = loop.run_until_complete(
                    processor.process_las_to_copc(
                        str(original_las_path),
                        pointcloud.id,
                        pointcloud.original_filename or f"{pointcloud.name}.las",
                    )
                )
                loop.close()

                final_message = (
                    "Clustering complete! Use 'Cluster' color mode to visualize."
                    if success
                    else "Clustering complete, but COPC reconversion failed. View clusters in summary only."
                )
                update_progress(current=overlay_steps, total=overlay_steps, message=final_message)
            except Exception as exc:
                update_progress(
                    current=overlay_steps,
                    total=overlay_steps,
                    message=f"Clustering complete, but failed to write to LAS: {exc}",
                )
        else:
            update_progress(
                current=overlay_steps,
                total=overlay_steps,
                message="Clustering complete (files missing for LAS writing)",
            )

        job.status = ClusterJobStatus.COMPLETED
        job.completed_at = datetime.utcnow()
        job.worker_task_id = None
        db.commit()
    except JobCancelledError:
        if job:
            job.status = ClusterJobStatus.CANCELLED
            job.progress_message = "Cluster generation cancelled."
            job.completed_at = datetime.utcnow()
            job.worker_task_id = None
            db.commit()
    except Exception as e:
        if job:
            job.status = ClusterJobStatus.FAILED
            job.error_details = {"error": str(e)}
            job.progress_message = f"Failed: {e}"
            job.completed_at = datetime.utcnow()
            job.worker_task_id = None
            db.commit()
        raise
    finally:
        if temp_dir and temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        db.close()

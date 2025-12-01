"""
Self-supervised PointNet-style training utilities backed by local LAS/LAZ data.

This module keeps everything backend-side so we can iterate on embeddings
without routing uploads through the frontend. It provides:
 - TrainingConfig: tunable parameters with sensible defaults.
 - PointPatchDataset: samples normalized patches directly from the pointcloud directory.
 - PointNet2Encoder + ProjectionHead: full PointNet++ hierarchy + SSL projection head.
 - SelfSupervisedPointNetTrainer: orchestrates dataloading, training, and checkpoints.
"""
from __future__ import annotations

import json
import math
import os
import platform
import random
import time
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import laspy
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset, get_worker_info
from tqdm import tqdm

from app.core.config import settings
from app.services.pointnet2 import PointNet2Encoder, ProjectionHead, nt_xent_loss, nt_xent_loss_with_hard_negatives

try:
    import copclib as copc
except ImportError:  # pragma: no cover
    copc = None


def _default_pointcloud_dir() -> Path:
    return Path(settings.pointcloud_output_dir).resolve()


def _default_output_dir() -> Path:
    return Path(settings.upload_dir).resolve() / "cluster_models"


GEOMETRIC_FEATURE_KEYS = [
    "linearity",
    "planarity",
    "scattering",
    "dominant_verticality",
    "normal_verticality",
    "z_range",
    "z_std",
    "intensity_mean",
    "intensity_std",
]


@dataclass
class TrainingConfig:
    """Configuration bundle for self-supervised PointNet training."""

    pointcloud_dir: Path = field(default_factory=_default_pointcloud_dir)
    output_dir: Path = field(default_factory=_default_output_dir)
    run_name: Optional[str] = None
    patches_per_file: int = 2048
    patch_size: int = 512
    patch_radius: float = 1.5
    batch_size: int = 32
    max_steps: int = 12000  # IMPROVED: Increased from 4000 to 12000 for better convergence
    log_every: int = 50
    checkpoint_every: int = 500
    learning_rate: float = 1e-3
    weight_decay: float = 1e-4
    temperature: float = 0.2
    jitter_std: float = 0.01
    jitter_clip: float = 0.05
    dropout_ratio: float = 0.1
    scale_jitter: float = 0.1
    use_intensity: bool = True
    num_workers: int = 8
    force_cpu: bool = False
    embedding_dim: int = 256
    projection_dim: int = 128
    chunk_size_points: int = 65536
    max_chunk_attempts: int = 4
    max_files_per_epoch: Optional[int] = None
    resume_from: Optional[Path] = None
    persistent_workers: bool = True
    prefetch_factor: int = 2
    auto_tune_workers: bool = True
    cache_pointclouds: bool = False
    max_cache_bytes: Optional[int] = None
    max_cached_files: int = 1

    def resolved_output_dir(self) -> Path:
        base = self.output_dir
        run_name = self.run_name or datetime.utcnow().strftime("selfsup-%Y%m%d-%H%M%S")
        run_dir = Path(base) / run_name
        run_dir.mkdir(parents=True, exist_ok=True)
        return run_dir


TrainingProgressCallback = Callable[[int, int, float], None]


def _limit_worker_threads(_: int) -> None:
    import os

    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")


def _worker_init(worker_id: int) -> None:
    """
    Seed per-worker RNGs and cap math library threads to keep WSL/macOS happy.
    """
    _limit_worker_threads(worker_id)
    info = get_worker_info()
    if info is not None and isinstance(info.dataset, PointPatchDataset):
        info.dataset.reseed(worker_id)


class PointPatchDataset(Dataset):
    """
    Generates point patches with two augmented views for contrastive training.
    Loads LAS/LAZ/COPC files directly from disk and caches them in-memory per file.
    """

    def __init__(
        self,
        root_dir: Path,
        patch_size: int = 512,
        patch_radius: float = 1.5,
        patches_per_file: int = 2048,
        use_intensity: bool = True,
        jitter_std: float = 0.01,
        jitter_clip: float = 0.05,
        dropout_ratio: float = 0.1,
        scale_jitter: float = 0.1,
        translation_xy_max: float = 0.5,
        translation_z_max: float = 0.3,
        coord_dropout_prob: float = 0.1,
        mode: str = "contrastive",
        return_metadata: bool = False,
        compute_geometric_features: bool = False,
        chunk_size_points: int = 65536,
        max_chunk_attempts: int = 4,
        max_files_per_epoch: Optional[int] = None,
    ) -> None:
        self.root_dir = Path(root_dir)
        self.patch_size = patch_size
        self.patch_radius = patch_radius
        self.patches_per_file = patches_per_file
        self.use_intensity = use_intensity
        self.jitter_std = jitter_std
        self.jitter_clip = jitter_clip
        self.dropout_ratio = dropout_ratio
        self.scale_jitter = scale_jitter
        self.translation_xy_max = translation_xy_max
        self.translation_z_max = translation_z_max
        self.coord_dropout_prob = coord_dropout_prob
        self.mode = mode
        self.return_metadata = return_metadata
        self.compute_geometric_features = compute_geometric_features
        self.chunk_size_points = max(chunk_size_points, patch_size)
        self.max_chunk_attempts = max(1, max_chunk_attempts)
        # When metadata is requested, capture provenance for overlays/QA.
        self.capture_metadata = return_metadata
        self.geometric_feature_keys = GEOMETRIC_FEATURE_KEYS

        if self.mode not in {"contrastive", "single"}:
            raise ValueError("mode must be 'contrastive' or 'single'")
        if self.return_metadata and self.mode != "single":
            raise ValueError("return_metadata is only supported when mode='single'.")

        self.file_paths: List[Path] = self._discover_pointclouds(limit=max_files_per_epoch)
        if not self.file_paths:
            raise FileNotFoundError(
                f"No LAS/LAZ files were found under {self.root_dir}. "
                "Populate the directory with local pointclouds first."
            )
        self.copc_files = [p for p in self.file_paths if p.suffix.lower() == ".copc" or p.name.endswith(".copc.laz")]

        self.file_point_counts: Dict[Path, int] = self._compute_point_counts()
        self._rng = np.random.default_rng()
        self._base_seed = int(time.time())
        self.cache_pointclouds = getattr(self, "cache_pointclouds", False)
        self.max_cache_bytes = getattr(self, "max_cache_bytes", None)
        self.max_cached_files = getattr(self, "max_cached_files", 0)
        self._cache: OrderedDict[Path, Dict[str, np.ndarray]] = OrderedDict()
        self._cache_sizes: Dict[Path, int] = {}
        self._cache_bytes: int = 0

    def _discover_pointclouds(self, limit: Optional[int] = None) -> List[Path]:
        supported_suffixes = {".las", ".laz"}
        files = []
        candidates = [self.root_dir] if self.root_dir.is_file() else self.root_dir.rglob("*")
        for path in sorted(candidates):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix in supported_suffixes or path.name.lower().endswith(".copc.laz"):
                files.append(path)
        if limit is not None and len(files) > limit:
            rng = random.Random(0)
            rng.shuffle(files)
            files = files[:limit]
        return files

    def _compute_point_counts(self) -> Dict[Path, int]:
        counts: Dict[Path, int] = {}
        for path in self.file_paths:
            with laspy.open(path) as reader:
                counts[path] = int(reader.header.point_count)
        return counts

    def _file_for_index(self, idx: int) -> Path:
        if not self.file_paths:
            raise RuntimeError("PointPatchDataset has no files to sample from.")
        if self.patches_per_file <= 0:
            raise ValueError("patches_per_file must be >= 1.")
        file_idx = (idx // self.patches_per_file) % len(self.file_paths)
        return self.file_paths[file_idx]

    def _sample_patch_from_file(self, path: Path) -> Tuple[np.ndarray, Optional[dict]]:
        total_points = self.file_point_counts[path]
        if total_points <= 0:
            raise ValueError(f"Point cloud {path} contains 0 points.")

        for _ in range(self.max_chunk_attempts):
            chunk = self._read_random_chunk(path, total_points)
            if chunk["xyz"].size == 0:
                continue
            patch, provenance = self._build_patch(chunk, path)
            if patch is not None:
                return patch, provenance

        # Final fallback: read once more and return whatever we can.
        chunk = self._read_random_chunk(path, total_points)
        patch, provenance = self._build_patch(chunk, path)
        if patch is None:
            raise RuntimeError(f"Failed to sample patch from {path}")
        return patch, provenance

    def _read_random_chunk(self, path: Path, total_points: int) -> Dict[str, np.ndarray]:
        chunk_size = min(self.chunk_size_points, max(total_points, 1))
        max_start = max(total_points - chunk_size, 0)
        start = 0 if max_start <= 0 else int(self._rng.integers(0, max_start + 1))

        with laspy.open(path) as reader:
            reader.seek(start)
            points = reader.read_points(chunk_size)

        xyz = np.vstack((points.x, points.y, points.z)).T.astype(np.float32)
        record: Dict[str, np.ndarray] = {"xyz": xyz}
        record["global_indices"] = np.arange(start, start + xyz.shape[0], dtype=np.int64)

        if self.use_intensity and hasattr(points, "intensity"):
            intensity = np.asarray(points.intensity, dtype=np.float32)
            if intensity.size:
                scale = float(np.percentile(intensity, 99))
                if scale <= 0:
                    scale = float(np.max(intensity))
                if scale > 0:
                    intensity = intensity / scale
            intensity = np.clip(intensity, 0.0, 1.0)
            record["intensity"] = intensity

        return record

    def _compute_surface_normal(self, xyz: np.ndarray) -> np.ndarray:
        """
        IMPROVED: Compute surface normal for patch using PCA.

        Args:
            xyz: (N, 3) point coordinates
        Returns:
            normal: (3,) surface normal vector
        """
        if xyz.size == 0 or len(xyz) < 3:
            return np.array([0.0, 0.0, 1.0], dtype=np.float32)

        centered = xyz - xyz.mean(axis=0, keepdims=True)
        cov = np.cov(centered, rowvar=False)
        eps = 1e-8
        cov = cov + np.eye(3) * eps

        evals, evecs = np.linalg.eigh(cov)
        # Surface normal is eigenvector with smallest eigenvalue
        normal = evecs[:, 0].astype(np.float32)

        # Enforce consistent orientation (point upward if possible)
        if normal[2] < 0:
            normal = -normal

        return normal

    def _build_patch(self, chunk: Dict[str, np.ndarray], file_path: Path) -> Tuple[Optional[np.ndarray], Optional[dict]]:
        xyz = chunk.get("xyz")
        if xyz is None or xyz.size == 0:
            return None, None

        count = xyz.shape[0]
        if count == 0:
            return None, None

        center_idx = int(self._rng.integers(0, count))
        center = xyz[center_idx]
        delta = xyz - center
        distances = np.linalg.norm(delta, axis=1)

        if count <= self.patch_size:
            indices = self._rng.choice(count, size=self.patch_size, replace=True)
        else:
            indices = np.argpartition(distances, self.patch_size - 1)[: self.patch_size]

        raw_patch_xyz = delta[indices].copy()
        patch_xyz = raw_patch_xyz.copy()
        max_norm = np.linalg.norm(patch_xyz, axis=1).max()
        if max_norm > 0:
            patch_xyz = patch_xyz / max_norm
        patch_xyz = patch_xyz * self.patch_radius

        features = [patch_xyz]

        # NOTE: Surface normal is computed in _compute_geometric_features()
        # and stored as patch-level metadata (normal_verticality feature)
        # We don't replicate it as per-point features (wasteful and confusing)

        intensity = chunk.get("intensity")
        if self.use_intensity and intensity is not None:
            if intensity.ndim == 1:
                intensity = intensity[:, None]
            intensity = intensity.astype(np.float32)
            intensity_slice = intensity[indices]
            features.append(intensity_slice)
        else:
            intensity_slice = None

        patch = np.concatenate(features, axis=1)

        provenance: Optional[dict] = None
        if self.capture_metadata and "global_indices" in chunk:
            provenance = {
                "file_path": str(file_path),
                "point_indices": chunk["global_indices"][indices].astype(np.int64).tolist(),
                "centroid": xyz[center_idx].astype(np.float32).tolist(),
            }
            if self.compute_geometric_features:
                geom = self._compute_geometric_features(raw_patch_xyz, intensity_slice)
                provenance["geometric_features"] = geom

        return np.ascontiguousarray(patch), provenance

    def _compute_geometric_features(
        self,
        xyz: np.ndarray,
        intensity: Optional[np.ndarray],
    ) -> Dict[str, float]:
        if xyz.size == 0:
            return {key: 0.0 for key in self.geometric_feature_keys}

        centered = xyz - xyz.mean(axis=0, keepdims=True)
        cov = np.cov(centered, rowvar=False)
        eps = 1e-8
        cov = cov + np.eye(3) * eps
        evals, evecs = np.linalg.eigh(cov)
        order = np.argsort(evals)[::-1]
        evals = evals[order]
        evecs = evecs[:, order]

        lambda0 = float(max(evals[0], eps))
        lambda1 = float(max(evals[1], eps))
        lambda2 = float(max(evals[2], eps))

        linearity = (lambda0 - lambda1) / lambda0
        planarity = (lambda1 - lambda2) / lambda0
        scattering = lambda2 / lambda0

        dominant_axis = evecs[:, 0]
        surface_normal = evecs[:, 2]
        dominant_verticality = float(abs(dominant_axis[2]))
        normal_verticality = float(abs(surface_normal[2]))

        z_vals = xyz[:, 2]
        z_range = float(z_vals.max() - z_vals.min())
        z_std = float(z_vals.std())

        if intensity is not None and intensity.size > 0:
            intensity_mean = float(np.mean(intensity))
            intensity_std = float(np.std(intensity))
        else:
            intensity_mean = 0.0
            intensity_std = 0.0

        return {
            "linearity": float(linearity),
            "planarity": float(planarity),
            "scattering": float(scattering),
            "dominant_verticality": dominant_verticality,
            "normal_verticality": normal_verticality,
            "z_range": z_range,
            "z_std": z_std,
            "intensity_mean": intensity_mean,
            "intensity_std": intensity_std,
        }

    def __len__(self) -> int:
        return max(1, len(self.file_paths)) * self.patches_per_file

    def feature_dimension(self) -> int:
        # XYZ (3) + optional intensity (1)
        # Surface normals are computed but stored in geometric features, not per-point
        return 4 if self.use_intensity else 3

    def reseed(self, worker_id: int) -> None:
        seed = (self._base_seed + worker_id + int(time.time())) % (2**63 - 1)
        self._rng = np.random.default_rng(seed)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        file_path = self._file_for_index(idx)
        patch, provenance = self._sample_patch_from_file(file_path)

        if self.mode == "contrastive":
            view_a = self._augment(patch)
            view_b = self._augment(patch)
            result: Tuple[torch.Tensor, ...] | torch.Tensor = (
                torch.from_numpy(view_a).float(),
                torch.from_numpy(view_b).float(),
            )
        else:
            result = torch.from_numpy(patch).float()

        if self.return_metadata:
            metadata = provenance or {"file_path": str(file_path)}
            return result, metadata
        return result

    def _load_points(self, path: Path) -> Dict[str, np.ndarray]:
        if self.cache_pointclouds:
            cached = self._cache.get(path)
            if cached is not None:
                self._cache.move_to_end(path)
                return cached

        with laspy.open(path) as reader:
            las = reader.read()

        xyz = np.vstack((las.x, las.y, las.z)).T.astype(np.float32)
        record: Dict[str, np.ndarray] = {"xyz": xyz}

        if self.use_intensity:
            if hasattr(las, "intensity"):
                intensity = np.asarray(las.intensity, dtype=np.float32)
                if intensity.size:
                    scale = float(np.percentile(intensity, 99))
                    if scale <= 0:
                        scale = float(np.max(intensity))
                    if scale > 0:
                        intensity = intensity / scale
                intensity = np.clip(intensity, 0.0, 1.0)
            else:
                intensity = np.zeros((xyz.shape[0],), dtype=np.float32)
            record["intensity"] = intensity

        if self.cache_pointclouds and self.max_cached_files > 0:
            self._cache[path] = record
            entry_bytes = sum(arr.nbytes for arr in record.values())
            self._cache_sizes[path] = entry_bytes
            self._cache_bytes += entry_bytes
            self._evict_cache_if_needed()

        return record

    def _evict_cache_if_needed(self) -> None:
        while self.max_cached_files and len(self._cache) > self.max_cached_files:
            self._pop_oldest_cache()
        if self.max_cache_bytes is not None:
            while self._cache_bytes > self.max_cache_bytes and self._cache:
                self._pop_oldest_cache()

    def _pop_oldest_cache(self) -> None:
        path, _ = self._cache.popitem(last=False)
        size = self._cache_sizes.pop(path, 0)
        self._cache_bytes = max(0, self._cache_bytes - size)

    def _sample_patch(self, data: Dict[str, np.ndarray]) -> np.ndarray:
        xyz = data["xyz"]
        total_points = xyz.shape[0]
        if total_points == 0:
            raise ValueError("Point cloud file contains 0 points.")

        center_idx = self._rng.integers(0, total_points)
        center = xyz[center_idx]
        delta = xyz - center
        distances = np.linalg.norm(delta, axis=1)

        indices: np.ndarray
        if self.patch_radius > 0:
            within_radius = np.nonzero(distances <= self.patch_radius)[0]
            if within_radius.size >= self.patch_size:
                indices = self._rng.choice(within_radius, size=self.patch_size, replace=False)
            elif total_points > self.patch_size:
                nearest = np.argpartition(distances, self.patch_size - 1)[: self.patch_size]
                indices = nearest
            else:
                indices = self._rng.choice(total_points, size=self.patch_size, replace=True)
        else:
            if total_points <= self.patch_size:
                indices = self._rng.choice(total_points, size=self.patch_size, replace=True)
            else:
                indices = np.argpartition(distances, self.patch_size - 1)[: self.patch_size]

        patch_xyz = delta[indices]

        if self.patch_radius > 0:
            patch_xyz = patch_xyz / max(self.patch_radius, 1e-6)
        else:
            max_norm = np.linalg.norm(patch_xyz, axis=1).max()
            if max_norm > 0:
                patch_xyz = patch_xyz / max_norm

        features = [patch_xyz]
        if self.use_intensity and "intensity" in data:
            intensity = data["intensity"][indices]
            if intensity.ndim == 1:
                intensity = intensity[:, None]
            features.append(intensity.astype(np.float32))

        patch = np.concatenate(features, axis=1)
        return np.ascontiguousarray(patch)

    def _augment(self, patch: np.ndarray) -> np.ndarray:
        augmented = patch.copy()

        theta = self._rng.uniform(0, 2 * math.pi)
        cos_theta, sin_theta = math.cos(theta), math.sin(theta)
        rotation = np.array(
            [[cos_theta, -sin_theta, 0.0], [sin_theta, cos_theta, 0.0], [0.0, 0.0, 1.0]],
            dtype=np.float32,
        )
        augmented[:, :3] = augmented[:, :3] @ rotation.T

        if self._rng.random() < 0.5:
            augmented[:, 0] *= -1
        if self._rng.random() < 0.5:
            augmented[:, 1] *= -1

        scale = 1.0 + self._rng.uniform(-self.scale_jitter, self.scale_jitter)
        augmented[:, :3] *= scale

        jitter = self._rng.normal(0.0, self.jitter_std, size=augmented[:, :3].shape)
        jitter = np.clip(jitter, -self.jitter_clip, self.jitter_clip)
        augmented[:, :3] += jitter

        # Small random translation to break absolute position cues
        t_xy = self._rng.uniform(-self.translation_xy_max, self.translation_xy_max, size=(2,))
        t_z = self._rng.uniform(-self.translation_z_max, self.translation_z_max)
        augmented[:, 0] += t_xy[0]
        augmented[:, 1] += t_xy[1]
        augmented[:, 2] += t_z

        # Rare coordinate dropout to weaken axis-specific memorization
        if self._rng.random() < self.coord_dropout_prob:
            axis = int(self._rng.integers(0, 3))
            augmented[:, axis] = 0.0

        if self.use_intensity and augmented.shape[1] > 3:
            intensity = augmented[:, 3:]
            jitter_factor = np.clip(1.0 + self._rng.normal(0.0, 0.05), 0.8, 1.2)
            intensity = np.clip(intensity * jitter_factor, 0.0, 1.0)
            augmented[:, 3:] = intensity

        augmented = self._apply_dropout(augmented)
        return np.ascontiguousarray(augmented)

    def _apply_dropout(self, patch: np.ndarray) -> np.ndarray:
        if self.dropout_ratio <= 0:
            return patch

        keep_mask = self._rng.random(self.patch_size) > self.dropout_ratio
        kept = patch[keep_mask]

        if kept.shape[0] == 0:
            kept = patch

        if kept.shape[0] < self.patch_size:
            resample_idx = self._rng.choice(kept.shape[0], size=self.patch_size - kept.shape[0], replace=True)
            kept = np.concatenate([kept, kept[resample_idx]], axis=0)
        elif kept.shape[0] > self.patch_size:
            choice = self._rng.choice(kept.shape[0], size=self.patch_size, replace=False)
            kept = kept[choice]

        return kept


class SelfSupervisedPointNetTrainer:
    """Orchestrates dataset creation, training loop, and checkpoints."""

    def __init__(self, config: TrainingConfig) -> None:
        self.config = config
        self.device = self._resolve_device()
        self.run_dir = config.resolved_output_dir()
        self._write_config()

    def _resolve_device(self) -> torch.device:
        if not self.config.force_cpu and torch.cuda.is_available():
            return torch.device("cuda")
        if torch.backends.mps.is_available() and not self.config.force_cpu:
            return torch.device("mps")
        return torch.device("cpu")

    def _config_json_ready(self) -> Dict[str, object]:
        payload = asdict(self.config)
        payload["pointcloud_dir"] = str(payload["pointcloud_dir"])
        payload["output_dir"] = str(payload["output_dir"])
        if payload.get("resume_from") is not None:
            payload["resume_from"] = str(payload["resume_from"])
        return payload

    def _write_config(self) -> None:
        config_path = self.run_dir / "config.json"
        config_path.write_text(json.dumps(self._config_json_ready(), indent=2))

    def _build_dataloader(self, dataset: PointPatchDataset) -> DataLoader:
        num_workers, persistent_workers, prefetch_factor = self._resolve_worker_settings()
        loader_kwargs = dict(
            dataset=dataset,
            batch_size=self.config.batch_size,
            shuffle=True,
            drop_last=True,
            num_workers=num_workers,
            pin_memory=(self.device.type == "cuda"),
        )
        if num_workers > 0:
            loader_kwargs.update(
                persistent_workers=persistent_workers,
                prefetch_factor=prefetch_factor,
                multiprocessing_context=torch.multiprocessing.get_context("spawn"),
                worker_init_fn=_worker_init,
            )
        return DataLoader(**loader_kwargs)

    def _resolve_worker_settings(self) -> Tuple[int, bool, Optional[int]]:
        num_workers = max(0, self.config.num_workers)
        persistent = self.config.persistent_workers and num_workers > 0
        prefetch = self.config.prefetch_factor if num_workers > 0 else None

        # IMPROVED: Detect WSL and clamp workers more aggressively
        # Memory issues occur even with num_workers=2 on WSL
        if self.config.auto_tune_workers and self._running_on_wsl() and num_workers > 0:
            tqdm.write("Detected WSL – clamping DataLoader workers to 0 for stability (memory issues).")
            num_workers = 0
            persistent = False
            prefetch = None

        # SAFETY: Disable persistent workers on WSL even if workers enabled manually
        # Prevents memory leaks in worker processes
        if self._running_on_wsl() and num_workers > 0:
            tqdm.write("Detected WSL – disabling persistent_workers to prevent memory leaks.")
            persistent = False

        if num_workers == 0:
            persistent = False
            prefetch = None

        return num_workers, persistent, prefetch

    @staticmethod
    def _running_on_wsl() -> bool:
        return "microsoft" in platform.release().lower()

    def train(self, progress_callback: TrainingProgressCallback | None = None) -> Path:
        dataset = PointPatchDataset(
            root_dir=self.config.pointcloud_dir,
            patch_size=self.config.patch_size,
            patch_radius=self.config.patch_radius,
            patches_per_file=self.config.patches_per_file,
            use_intensity=self.config.use_intensity,
            jitter_std=self.config.jitter_std,
            jitter_clip=self.config.jitter_clip,
            dropout_ratio=self.config.dropout_ratio,
            scale_jitter=self.config.scale_jitter,
            chunk_size_points=self.config.chunk_size_points,
            max_chunk_attempts=self.config.max_chunk_attempts,
            max_files_per_epoch=self.config.max_files_per_epoch,
        )

        dataloader = self._build_dataloader(dataset)

        encoder = PointNet2Encoder(
            in_ch=max(dataset.feature_dimension() - 3, 0),
            emb_dim=self.config.embedding_dim,
        ).to(self.device)
        projector = ProjectionHead(
            emb_dim=self.config.embedding_dim,
            proj_dim=self.config.projection_dim,
        ).to(self.device)

        optimizer = torch.optim.AdamW(
            list(encoder.parameters()) + list(projector.parameters()),
            lr=self.config.learning_rate,
            weight_decay=self.config.weight_decay,
        )
        start_step = 0
        if self.config.resume_from:
            checkpoint = torch.load(self.config.resume_from, map_location=self.device)
            if "encoder_state" in checkpoint:
                encoder.load_state_dict(checkpoint["encoder_state"])
            if "projector_state" in checkpoint:
                projector.load_state_dict(checkpoint["projector_state"])
            if "optimizer_state" in checkpoint:
                optimizer.load_state_dict(checkpoint["optimizer_state"])
                for group in optimizer.param_groups:
                    group.setdefault("initial_lr", group.get("lr", self.config.learning_rate))
            start_step = int(checkpoint.get("step", 0))
            tqdm.write(f"Resuming training from step {start_step} using {self.config.resume_from}")
        else:
            for group in optimizer.param_groups:
                group.setdefault("initial_lr", group.get("lr", self.config.learning_rate))

        eta_min = self.config.learning_rate * 0.1
        warmup_steps = max(1, int(0.05 * self.config.max_steps))
        total_steps = self.config.max_steps

        def lr_lambda(current_step: int) -> float:
            if current_step < warmup_steps:
                return float(current_step + 1) / float(warmup_steps)
            progress = (current_step - warmup_steps) / max(1, total_steps - warmup_steps)
            cosine = 0.5 * (1.0 + math.cos(math.pi * progress))
            min_factor = eta_min / self.config.learning_rate
            return min_factor + (1 - min_factor) * cosine

        scheduler = torch.optim.lr_scheduler.LambdaLR(
            optimizer,
            lr_lambda=lr_lambda,
            last_epoch=start_step,
        )

        scaler = torch.cuda.amp.GradScaler(enabled=self.device.type == "cuda")

        step = start_step
        metrics_path = self.run_dir / "metrics.jsonl"
        metrics_file = metrics_path.open("a")

        progress = tqdm(
            total=self.config.max_steps,
            desc="Self-supervised training",
            unit="step",
            initial=start_step,
        )
        encoder.train()
        projector.train()

        last_loss_value = 0.0
        if progress_callback:
            progress_callback(step, self.config.max_steps, 0.0)

        progress_interval = max(1, self.config.log_every // 2)

        while step < self.config.max_steps:
            for view_a, view_b in dataloader:
                if step >= self.config.max_steps:
                    break

                view_a = view_a.to(self.device)
                view_b = view_b.to(self.device)

                optimizer.zero_grad()
                with torch.cuda.amp.autocast(enabled=self.device.type == "cuda"):
                    feat_a = encoder(view_a)
                    feat_b = encoder(view_b)
                    proj_a = projector(feat_a)
                    proj_b = projector(feat_b)
                    # IMPROVED: Use hard negative mining for better discriminative features
                    loss = nt_xent_loss_with_hard_negatives(
                        proj_a, proj_b,
                        temperature=self.config.temperature,
                        hard_negative_weight=2.0
                    )

                scaler.scale(loss).backward()
                prev_optimizer_steps = getattr(optimizer, "_step_count", None)
                scaler.step(optimizer)
                scaler.update()
                current_optimizer_steps = getattr(optimizer, "_step_count", None)
                if (
                    current_optimizer_steps is None
                    or prev_optimizer_steps is None
                    or current_optimizer_steps > prev_optimizer_steps
                ):
                    scheduler.step()

                step += 1
                progress.update(1)
                progress.set_postfix(
                    {
                        "loss": f"{loss.item():.4f}",
                        "lr": f"{optimizer.param_groups[0]['lr']:.2e}",
                    }
                )
                last_loss_value = float(loss.item())

                if progress_callback and (step % progress_interval == 0 or step == self.config.max_steps):
                    progress_callback(step, self.config.max_steps, last_loss_value)

                if step % self.config.log_every == 0 or step == 1:
                    log_entry = {
                        "step": step,
                        "loss": float(loss.item()),
                        "lr": float(optimizer.param_groups[0]["lr"]),
                    }
                    metrics_file.write(json.dumps(log_entry) + "\n")
                    metrics_file.flush()

                if step % self.config.checkpoint_every == 0 or step == self.config.max_steps:
                    self._save_checkpoint(encoder, projector, optimizer, step)

        metrics_file.close()
        progress.close()
        if progress_callback:
            progress_callback(self.config.max_steps, self.config.max_steps, last_loss_value)
        final_checkpoint = self.run_dir / f"checkpoint-step{step}.pt"
        return final_checkpoint

    def _save_checkpoint(
        self,
        encoder: PointNet2Encoder,
        projector: ProjectionHead,
        optimizer: torch.optim.Optimizer,
        step: int,
    ) -> None:
        payload = {
            "step": step,
            "encoder_state": encoder.state_dict(),
            "projector_state": projector.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "config": self._config_json_ready(),
        }
        checkpoint_path = self.run_dir / f"checkpoint-step{step}.pt"
        torch.save(payload, checkpoint_path)
        latest_path = self.run_dir / "latest.pt"
        torch.save(payload, latest_path)


__all__ = [
    "PointPatchDataset",
    "SelfSupervisedPointNetTrainer",
    "TrainingConfig",
    "GEOMETRIC_FEATURE_KEYS",
]

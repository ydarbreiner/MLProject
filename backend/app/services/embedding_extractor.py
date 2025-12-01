from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import numpy as np
import torch
from torch.utils.data import DataLoader

from app.core.config import settings
from app.services.pointnet2 import PointNet2Encoder
from app.services.self_supervised_training import GEOMETRIC_FEATURE_KEYS, PointPatchDataset


def _default_pointcloud_dir() -> Path:
    return Path(settings.pointcloud_output_dir).resolve()


def _default_output_dir() -> Path:
    return Path(settings.upload_dir).resolve() / "cluster_models"


@dataclass
class EmbeddingExtractionConfig:
    checkpoint_path: Path
    pointcloud_dir: Path = field(default_factory=_default_pointcloud_dir)
    output_dir: Path = field(default_factory=_default_output_dir)
    job_name: str | None = None
    patches_per_file: int = 2048
    patch_size: int = 512
    patch_radius: float = 1.5
    batch_size: int = 64
    num_workers: int = 4
    use_intensity: bool = True
    embedding_dim: int = 256
    device: str | None = None
    chunk_size_points: int = 65536
    max_chunk_attempts: int = 4
    max_files_per_epoch: int | None = None
    include_geometric_features: bool = True

    def resolved_device(self) -> torch.device:
        if self.device:
            return torch.device(self.device)
        if torch.cuda.is_available():
            return torch.device("cuda")
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    def resolved_job_name(self) -> str:
        if self.job_name:
            return self.job_name
        return Path(self.checkpoint_path).stem + "-embeddings"

    def resolved_output_dir(self) -> Path:
        base_dir = Path(self.output_dir)
        if base_dir.is_file():
            raise ValueError("--output-dir must be a directory, not a file.")
        job_dir = base_dir / self.resolved_job_name()
        job_dir.mkdir(parents=True, exist_ok=True)
        return job_dir


EmbeddingProgressCallback = Callable[[int, int, str], None]


class EmbeddingExtractor:
    def __init__(self, config: EmbeddingExtractionConfig) -> None:
        self.config = config
        self.device = config.resolved_device()
        self.job_name = config.resolved_job_name()
        self.output_dir = config.resolved_output_dir()

    def _build_dataloader(self) -> DataLoader:
        dataset = PointPatchDataset(
            root_dir=self.config.pointcloud_dir,
            patch_size=self.config.patch_size,
            patch_radius=self.config.patch_radius,
            patches_per_file=self.config.patches_per_file,
            use_intensity=self.config.use_intensity,
            jitter_std=0.0,
            jitter_clip=0.0,
            dropout_ratio=0.0,
            scale_jitter=0.0,
            mode="single",
            return_metadata=True,
            compute_geometric_features=self.config.include_geometric_features,
            chunk_size_points=self.config.chunk_size_points,
            max_chunk_attempts=self.config.max_chunk_attempts,
            max_files_per_epoch=self.config.max_files_per_epoch,
        )

        def collate_fn(batch: List[Tuple[torch.Tensor, Dict[str, int]]]) -> Tuple[torch.Tensor, List[Dict[str, int]]]:
            patches = torch.stack([item[0] for item in batch], dim=0)
            metadata = [item[1] for item in batch]
            return patches, metadata

        dataloader_kwargs = dict(
            dataset=dataset,
            batch_size=self.config.batch_size,
            shuffle=False,
            num_workers=self.config.num_workers,
            pin_memory=(self.device.type == "cuda"),
            collate_fn=collate_fn,
        )
        if self.config.num_workers > 0:
            dataloader_kwargs.update(
                persistent_workers=True,
                prefetch_factor=2,
            )
        return DataLoader(**dataloader_kwargs)

    def _load_encoder(self, feature_dim: int) -> PointNet2Encoder:
        checkpoint = torch.load(self.config.checkpoint_path, map_location=self.device)
        emb_dim = checkpoint.get("config", {}).get("embedding_dim", self.config.embedding_dim)
        encoder = PointNet2Encoder(
            in_ch=max(feature_dim - 3, 0),
            emb_dim=emb_dim,
        ).to(self.device)
        encoder.load_state_dict(checkpoint["encoder_state"])
        encoder.eval()
        self._checkpoint_metadata = {
            "step": checkpoint.get("step"),
            "config": checkpoint.get("config"),
        }
        return encoder

    def extract(self, progress_callback: EmbeddingProgressCallback | None = None) -> Path:
        dataloader = self._build_dataloader()
        feature_dim = dataloader.dataset.feature_dimension()  # type: ignore[attr-defined]
        encoder = self._load_encoder(feature_dim)

        embeddings: List[torch.Tensor] = []
        file_indices: List[int] = []
        patch_indices: List[int] = []
        file_lookup: Dict[str, int] = {}
        file_paths: List[str] = []
        provenance: List[dict] = []
        geometric_features: List[np.ndarray] = []
        global_patch_idx = 0

        total_batches = len(dataloader)
        batch_idx = 0
        target_total = self.config.patches_per_file or total_batches * self.config.batch_size
        progress_interval = max(1, total_batches // 100 or 1)

        with torch.no_grad():
            for patches, metadata in dataloader:
                patches = patches.to(self.device)
                emb = encoder(patches).cpu()
                embeddings.append(emb)
                for meta in metadata:
                    path = meta["file_path"]
                    patch_idx = global_patch_idx
                    if path not in file_lookup:
                        file_lookup[path] = len(file_paths)
                        file_paths.append(path)
                    file_indices.append(file_lookup[path])
                    patch_indices.append(patch_idx)
                    provenance.append(
                        {
                            "embeddingIndex": patch_idx,
                            "filePath": path,
                            "pointIndices": meta.get("point_indices") or [],
                            "centroid": meta.get("centroid"),
                            "geometricFeatures": meta.get("geometric_features"),
                        }
                    )
                    if self.config.include_geometric_features:
                        geom_meta = meta.get("geometric_features")
                        if geom_meta is not None:
                            ordered = [float(geom_meta.get(key, 0.0)) for key in GEOMETRIC_FEATURE_KEYS]
                            geometric_features.append(np.asarray(ordered, dtype=np.float32))
                        else:
                            geometric_features.append(np.zeros(len(GEOMETRIC_FEATURE_KEYS), dtype=np.float32))
                    global_patch_idx += 1

                batch_idx += 1
                if batch_idx % progress_interval == 0 or batch_idx == total_batches:
                    progress_pct = (global_patch_idx / max(1, target_total)) * 100
                    message = (
                        f"Extracting embeddings: {global_patch_idx:,} / ~{target_total:,} patches "
                        f"({progress_pct:.1f}%)"
                    )
                    if progress_callback:
                        progress_callback(global_patch_idx, target_total, message)
                    else:
                        print(message)

        if not embeddings:
            raise RuntimeError("No embeddings were generated; check dataset configuration.")

        embeddings_tensor = torch.cat(embeddings, dim=0)
        embeddings_np = embeddings_tensor.numpy().astype(np.float32)
        geom_np: np.ndarray | None = None
        if self.config.include_geometric_features and geometric_features:
            geom_np = np.vstack(geometric_features).astype(np.float32)
        file_indices_np = np.asarray(file_indices, dtype=np.int32)
        patch_indices_np = np.asarray(patch_indices, dtype=np.int32)
        file_paths_np = np.asarray(file_paths, dtype="U512")

        artifact_path = self.output_dir / "embeddings.npz"
        npz_payload = {
            "embeddings": embeddings_np,
            "file_indices": file_indices_np,
            "patch_indices": patch_indices_np,
            "file_paths": file_paths_np,
        }
        if geom_np is not None:
            npz_payload["geometric_features"] = geom_np
            npz_payload["geometric_feature_keys"] = np.asarray(GEOMETRIC_FEATURE_KEYS, dtype="U64")

        np.savez_compressed(artifact_path, **npz_payload)

        message = (
            f"Extracting embeddings: {embeddings_np.shape[0]:,} / ~{target_total:,} patches (100.0%)"
        )
        if progress_callback:
            progress_callback(embeddings_np.shape[0], target_total, message)
        else:
            print(message)

        metadata = {
            "jobName": self.job_name,
            "createdAt": datetime.utcnow().isoformat() + "Z",
            "checkpointPath": str(self.config.checkpoint_path),
            "pointcloudDir": str(self.config.pointcloud_dir),
            "patchesPerFile": self.config.patches_per_file,
            "patchSize": self.config.patch_size,
            "patchRadius": self.config.patch_radius,
            "batchSize": self.config.batch_size,
            "numWorkers": self.config.num_workers,
            "useIntensity": self.config.use_intensity,
            "includeGeometricFeatures": self.config.include_geometric_features,
            "embeddingDim": embeddings_np.shape[1],
            "geometricFeaturesDim": int(geom_np.shape[1]) if geom_np is not None else 0,
            "geometricFeatureKeys": GEOMETRIC_FEATURE_KEYS if geom_np is not None else [],
            "totalEmbeddings": int(embeddings_np.shape[0]),
            "fileCount": len(file_paths),
            "filePaths": file_paths,
            "checkpointMeta": self._checkpoint_metadata,
        }
        metadata_path = self.output_dir / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2))

        provenance_path = self.output_dir / "patch_provenance.jsonl"
        with provenance_path.open("w") as handle:
            for record in provenance:
                handle.write(json.dumps(record) + "\n")

        (self.output_dir / "artifacts.json").write_text(json.dumps({
            "embeddings": str(artifact_path),
            "metadata": str(metadata_path),
            "patchProvenance": str(provenance_path),
        }, indent=2))
        return artifact_path


__all__ = ["EmbeddingExtractionConfig", "EmbeddingExtractor"]

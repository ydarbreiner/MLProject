#!/usr/bin/env python3
"""
CLI for extracting PointNet embeddings from a trained checkpoint.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.config import settings
from app.services.embedding_extractor import EmbeddingExtractionConfig, EmbeddingExtractor


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract embeddings using a trained PointNet encoder checkpoint.")
    parser.add_argument("--checkpoint", type=Path, required=True, help="Path to checkpoint-stepXXXX.pt or latest.pt.")
    parser.add_argument(
        "--pointcloud-dir",
        type=Path,
        help="Directory with LAS/LAZ files (defaults to settings.pointcloud_output_dir).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory where the embedding job folder will be created (defaults to <checkpoint_dir>/embeddings).",
    )
    parser.add_argument("--job-name", type=str, help="Optional name for the embedding job directory.")
    parser.add_argument("--patches-per-file", type=int, default=2048)
    parser.add_argument("--patch-size", type=int, default=512)
    parser.add_argument("--patch-radius", type=float, default=1.5)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--num-workers", type=int, default=4)
    parser.add_argument("--chunk-size-points", type=int, help="Points per chunk when sampling patches.")
    parser.add_argument("--max-chunk-attempts", type=int, help="How many chunk retries before falling back.")
    parser.add_argument("--max-files-per-epoch", type=int, help="Limit number of LAS/LAZ files sampled per epoch.")
    parser.add_argument("--no-intensity", action="store_true", help="Ignore intensity channel even if present.")
    parser.add_argument(
        "--device",
        choices=["cpu", "cuda", "mps"],
        help="Force a specific device; defaults to CUDA→MPS→CPU fallback.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    checkpoint = args.checkpoint.resolve()
    if not checkpoint.exists():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint}")

    pointcloud_dir = (args.pointcloud_dir or Path(settings.pointcloud_output_dir)).resolve()
    if not pointcloud_dir.exists():
        raise FileNotFoundError(f"Pointcloud directory not found: {pointcloud_dir}")

    if args.output_dir:
        output_dir = args.output_dir.resolve()
    else:
        output_dir = checkpoint.parent / "embeddings"
    output_dir.mkdir(parents=True, exist_ok=True)

    config = EmbeddingExtractionConfig(
        checkpoint_path=checkpoint,
        pointcloud_dir=pointcloud_dir,
        output_dir=output_dir,
        job_name=args.job_name,
        patches_per_file=args.patches_per_file,
        patch_size=args.patch_size,
        patch_radius=args.patch_radius,
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        use_intensity=not args.no_intensity,
        device=args.device,
        chunk_size_points=args.chunk_size_points or 65536,
        max_chunk_attempts=args.max_chunk_attempts or 4,
        max_files_per_epoch=args.max_files_per_epoch,
    )

    extractor = EmbeddingExtractor(config)
    artifact_path = extractor.extract()
    print(f"✅ Embeddings saved to {artifact_path}")


if __name__ == "__main__":
    main()

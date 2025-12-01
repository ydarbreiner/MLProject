#!/usr/bin/env python3
"""
CLI entry point for running self-supervised PointNet training directly against
local LAS/LAZ files under the pointcloud directory. No frontend upload required.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

# Ensure backend package is importable when executing this script directly.
BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.self_supervised_training import (
    SelfSupervisedPointNetTrainer,
    TrainingConfig,
)


def parse_args() -> argparse.Namespace:
    default_config = TrainingConfig()
    parser = argparse.ArgumentParser(
        description="Train the self-supervised PointNet encoder on local pointcloud files."
    )
    parser.add_argument(
        "--pointcloud-dir",
        type=Path,
        default=default_config.pointcloud_dir,
        help="Directory that contains LAS/LAZ files (defaults to config.pointcloud_output_dir).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=default_config.output_dir,
        help="Directory to store checkpoints + metrics (defaults to uploads/cluster_models).",
    )
    parser.add_argument("--run-name", type=str, default=default_config.run_name, help="Optional name for this run.")
    parser.add_argument(
        "--patches-per-file",
        type=int,
        default=default_config.patches_per_file,
        help="How many patch samples to draw from each LAS/LAZ file.",
    )
    parser.add_argument("--patch-size", type=int, default=default_config.patch_size, help="Number of points per patch.")
    parser.add_argument("--patch-radius", type=float, default=default_config.patch_radius, help="Patch radius in meters.")
    parser.add_argument("--batch-size", type=int, default=default_config.batch_size)
    parser.add_argument("--max-steps", type=int, default=default_config.max_steps)
    parser.add_argument("--learning-rate", type=float, default=default_config.learning_rate)
    parser.add_argument("--weight-decay", type=float, default=default_config.weight_decay)
    parser.add_argument("--temperature", type=float, default=default_config.temperature)
    parser.add_argument("--log-every", type=int, default=default_config.log_every)
    parser.add_argument("--checkpoint-every", type=int, default=default_config.checkpoint_every)
    parser.add_argument("--num-workers", type=int, default=default_config.num_workers)
    parser.add_argument("--jitter-std", type=float, default=default_config.jitter_std)
    parser.add_argument("--jitter-clip", type=float, default=default_config.jitter_clip)
    parser.add_argument("--dropout-ratio", type=float, default=default_config.dropout_ratio)
    parser.add_argument("--scale-jitter", type=float, default=default_config.scale_jitter)
    parser.add_argument("--embedding-dim", type=int, default=default_config.embedding_dim)
    parser.add_argument("--projection-dim", type=int, default=default_config.projection_dim)
    parser.add_argument(
        "--chunk-size-points",
        type=int,
        default=default_config.chunk_size_points,
        help="How many points to read from a file per patch sample.",
    )
    parser.add_argument(
        "--max-chunk-attempts",
        type=int,
        default=default_config.max_chunk_attempts,
        help="Number of chunk retries when a file does not have enough local density.",
    )
    parser.add_argument(
        "--max-files-per-epoch",
        type=int,
        help="Limit the number of LAS/LAZ files sampled per epoch (random subset).",
    )
    parser.add_argument(
        "--no-intensity",
        action="store_true",
        help="Disable intensity channel usage even if present in LAS/LAZ files.",
    )
    parser.add_argument(
        "--no-cache-pointclouds",
        action="store_true",
        help="Avoid caching entire LAS/LAZ files in RAM (useful on low-memory systems).",
    )
    parser.add_argument(
        "--no-persistent-workers",
        action="store_true",
        help="Disable persistent DataLoader workers (recommended for unstable WSL setups).",
    )
    parser.add_argument(
        "--no-auto-tune-workers",
        action="store_true",
        help="Skip automatic WSL worker clamping.",
    )
    parser.add_argument(
        "--resume-from",
        type=Path,
        default=default_config.resume_from,
        help="Optional checkpoint to resume from (loads encoder/projector/optimizer).",
    )
    parser.add_argument("--force-cpu", action="store_true", help="Force CPU even if CUDA/MPS is available.")
    parser.add_argument(
        "--render-plots",
        action="store_true",
        help="Run scripts/render_training_png.py after training to produce PNG charts.",
    )
    parser.add_argument(
        "--plot-prefix",
        type=str,
        help="Optional filename prefix for generated PNGs (defaults to run name).",
    )
    parser.add_argument(
        "--plot-ema-alpha",
        type=float,
        default=0.35,
        help="EMA smoothing factor passed to render_training_png.py when --render-plots is set.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = TrainingConfig(
        pointcloud_dir=args.pointcloud_dir,
        output_dir=args.output_dir,
        run_name=args.run_name,
        patches_per_file=args.patches_per_file,
        patch_size=args.patch_size,
        patch_radius=args.patch_radius,
        batch_size=args.batch_size,
        max_steps=args.max_steps,
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        temperature=args.temperature,
        log_every=args.log_every,
        checkpoint_every=args.checkpoint_every,
        num_workers=args.num_workers,
        jitter_std=args.jitter_std,
        jitter_clip=args.jitter_clip,
        dropout_ratio=args.dropout_ratio,
        scale_jitter=args.scale_jitter,
        embedding_dim=args.embedding_dim,
        projection_dim=args.projection_dim,
        use_intensity=not args.no_intensity,
        force_cpu=args.force_cpu,
        resume_from=args.resume_from,
        persistent_workers=not args.no_persistent_workers,
        auto_tune_workers=not args.no_auto_tune_workers,
        cache_pointclouds=not args.no_cache_pointclouds,
        chunk_size_points=args.chunk_size_points,
        max_chunk_attempts=args.max_chunk_attempts,
        max_files_per_epoch=args.max_files_per_epoch,
    )

    trainer = SelfSupervisedPointNetTrainer(config)
    checkpoint_path = trainer.train()
    print(f"✅ Training complete. Latest checkpoint saved to: {checkpoint_path}")

    if args.render_plots:
        metrics_path = trainer.run_dir / "metrics.jsonl"
        if not metrics_path.exists():
            print(f"⚠️ Metrics file not found at {metrics_path}; skipping PNG rendering.")
            return

        repo_root = BACKEND_DIR.parent
        plot_script = repo_root / "scripts" / "render_training_png.py"
        if not plot_script.exists():
            print(f"⚠️ Plot script missing at {plot_script}; skipping PNG rendering.")
            return

        prefix = args.plot_prefix or trainer.run_dir.name
        plot_cmd = [
            sys.executable,
            str(plot_script),
            "--metrics-file",
            str(metrics_path),
            "--output-dir",
            str(trainer.run_dir),
            "--prefix",
            prefix,
            "--ema-alpha",
            f"{args.plot_ema_alpha}",
        ]
        print("🖼️  Rendering PNG charts...")
        try:
            subprocess.run(plot_cmd, check=True)
            print(f"✅ Charts saved under {trainer.run_dir}")
        except subprocess.CalledProcessError as exc:
            print(f"⚠️ Failed to render charts: {exc}")


if __name__ == "__main__":
    main()

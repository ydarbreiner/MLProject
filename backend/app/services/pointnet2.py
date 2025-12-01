"""
PointNet++ encoder implementation used by the self-supervised trainer.

This module mirrors the plan described in the assignment:
 1. Low-level sampling/grouping utilities (FPS, ball query, indexing).
 2. Single-scale Set Abstraction layers (PointNet blocks applied to local neighborhoods).
 3. Hierarchical encoder (three SA levels + global pooling) that outputs a 256-D embedding.
 4. Projection head + NT-Xent loss for contrastive self-supervised learning.

Every step is commented so it can be cited/explained in the accompanying write-up.
"""
from __future__ import annotations

from typing import List, Optional

import torch
from torch import nn
import torch.nn.functional as F


# ---------------------------------------------------------------------------
# Low-level geometric helpers
# ---------------------------------------------------------------------------

def square_distance(src: torch.Tensor, dst: torch.Tensor) -> torch.Tensor:
    """
    Compute pairwise squared Euclidean distance between two batched point sets.

    Args:
        src: (B, N, C) tensor
        dst: (B, M, C) tensor
    Returns:
        dist: (B, N, M) tensor of squared distances
    """
    dist = -2 * torch.matmul(src, dst.transpose(1, 2))
    dist += torch.sum(src ** 2, dim=-1).unsqueeze(-1)
    dist += torch.sum(dst ** 2, dim=-1).unsqueeze(1)
    return dist


def index_points(points: torch.Tensor, idx: torch.Tensor) -> torch.Tensor:
    """
    Gather points using an index tensor that may have extra dims (e.g., FPS, grouping).

    Args:
        points: (B, N, C)
        idx: (B, S) or (B, S, K)
    Returns:
        gathered: same shape as idx with trailing C features
    """
    B = points.shape[0]
    view_shape = list(idx.shape) + [points.shape[-1]]
    batch_idx_shape = [B] + [1] * (idx.dim() - 1)
    batch_idx = torch.arange(B, dtype=torch.long, device=points.device).view(*batch_idx_shape).expand_as(idx)
    return points[batch_idx, idx, :].view(*view_shape)


def farthest_point_sample(xyz: torch.Tensor, npoint: int) -> torch.Tensor:
    """
    Iterative FPS to choose well-spread centroids for the set abstraction layers.

    Args:
        xyz: (B, N, 3) coordinates
        npoint: number of centroids to select
    Returns:
        centroids: (B, npoint) indices
    """
    device = xyz.device
    B, N, _ = xyz.shape
    centroids = torch.zeros(B, npoint, dtype=torch.long, device=device)
    distance = torch.full((B, N), 1e10, device=device)
    farthest = torch.randint(0, N, (B,), dtype=torch.long, device=device)
    batch_indices = torch.arange(B, dtype=torch.long, device=device)

    for i in range(npoint):
        centroids[:, i] = farthest
        centroid = xyz[batch_indices, farthest, :].view(B, 1, 3)
        dist = torch.sum((xyz - centroid) ** 2, dim=-1)
        mask = dist < distance
        distance[mask] = dist[mask]
        farthest = torch.max(distance, dim=-1)[1]

    return centroids


def query_ball_point(radius: float, nsample: int, xyz: torch.Tensor, new_xyz: torch.Tensor) -> torch.Tensor:
    """
    Group neighboring points within a radius for each centroid.

    Args:
        radius: search radius in meters
        nsample: maximum neighbors to collect
        xyz: all points (B, N, 3)
        new_xyz: centroids (B, S, 3)
    Returns:
        idx: (B, S, nsample) neighbor indices
    """
    B, N, _ = xyz.shape
    S = new_xyz.shape[1]
    group_idx = torch.arange(N, dtype=torch.long, device=xyz.device).view(1, 1, N).repeat(B, S, 1)
    sqrdists = square_distance(new_xyz, xyz)
    group_idx[sqrdists > radius ** 2] = N  # mark points outside the radius
    group_idx = group_idx.sort(dim=-1)[0][:, :, :nsample]
    effective_nsample = group_idx.shape[-1]
    group_first = group_idx[:, :, 0].unsqueeze(-1).repeat(1, 1, effective_nsample)
    mask = group_idx == N
    group_idx[mask] = group_first[mask]  # duplicate first neighbor if insufficient points
    return group_idx


# ---------------------------------------------------------------------------
# Set Abstraction (single-scale)
# ---------------------------------------------------------------------------

class PointNetSetAbstraction(nn.Module):
    """
    Single-scale set abstraction layer:
      1. Sample centroids (FPS).
      2. Group local patches by radius.
      3. Normalize to local frame (subtract centroid).
      4. Run a shared PointNet (MLP + max pool) to summarize each neighborhood.
    """

    def __init__(self, npoint: Optional[int], radius: float, nsample: int, in_ch: int, mlp_channels: List[int], use_bn: bool = True) -> None:
        super().__init__()
        self.npoint = npoint
        self.radius = radius
        self.nsample = nsample
        last_ch = in_ch + 3  # we append XYZ offsets to the incoming features
        layers: List[nn.Module] = []
        for out_ch in mlp_channels:
            layers.append(nn.Conv2d(last_ch, out_ch, kernel_size=1, bias=not use_bn))
            if use_bn:
                layers.append(nn.BatchNorm2d(out_ch))
            layers.append(nn.ReLU(inplace=True))
            last_ch = out_ch
        self.mlp = nn.Sequential(*layers)

    def forward(self, xyz: torch.Tensor, features: Optional[torch.Tensor]) -> tuple[torch.Tensor, torch.Tensor]:
        B, N, _ = xyz.shape

        # Sample centroids either via FPS (for local layers) or by averaging (global layer).
        if self.npoint is None:
            new_xyz = xyz.mean(dim=1, keepdim=True)
        else:
            fps_idx = farthest_point_sample(xyz, self.npoint)
            new_xyz = index_points(xyz, fps_idx)

        # Group neighbors for each centroid.
        if self.npoint is None:
            grouped_xyz = xyz.unsqueeze(1)
            grouped_features = features.unsqueeze(1) if features is not None else None
        else:
            idx = query_ball_point(self.radius, self.nsample, xyz, new_xyz)
            grouped_xyz = index_points(xyz, idx)
            grouped_features = index_points(features, idx) if features is not None else None

        # Translate to local coordinates so the network learns shape, not absolute position.
        local_xyz = grouped_xyz - new_xyz.unsqueeze(2)

        if grouped_features is None:
            local_features = local_xyz
        else:
            local_features = torch.cat([local_xyz, grouped_features], dim=-1)

        # Shared MLP across all points in the neighborhood (PointNet style).
        local_features = local_features.permute(0, 3, 1, 2)  # (B, C, S, K)
        local_features = self.mlp(local_features)
        new_features = torch.max(local_features, dim=3).values  # symmetric pooling → (B, C_out, S)
        new_features = new_features.permute(0, 2, 1)
        return new_xyz, new_features


# ---------------------------------------------------------------------------
# Hierarchical Encoder + Projection Head
# ---------------------------------------------------------------------------

class PointNet2Encoder(nn.Module):
    """
    Hierarchical PointNet++ encoder with three single-scale SA layers:
        SA1 captures micro-geometry (0.10 m)
        SA2 captures meso-geometry (0.30 m)
        SA3 captures macro-geometry (1.00 m)
    The resulting features are globally max-pooled and projected to a 256-D embedding.
    """

    def __init__(
        self,
        in_ch: int = 3,
        emb_dim: int = 256,
    ) -> None:
        super().__init__()
        self.sa1 = PointNetSetAbstraction(
            npoint=256,
            radius=0.10,
            nsample=48,
            in_ch=in_ch,
            mlp_channels=[64, 64, 128],
        )
        self.sa2 = PointNetSetAbstraction(
            npoint=128,
            radius=0.50,  # IMPROVED: Increased from 0.30m to 0.50m for better context
            nsample=96,   # IMPROVED: Increased from 64 to 96 samples
            in_ch=128,
            mlp_channels=[128, 128, 256],
        )
        self.sa3 = PointNetSetAbstraction(
            npoint=64,
            radius=2.00,  # IMPROVED: Increased from 1.00m to 2.00m for macro context
            nsample=128,  # IMPROVED: Increased from 96 to 128 samples
            in_ch=256,
            mlp_channels=[256, 256, 512],
        )

        # IMPROVED: Multi-scale feature fusion (896-D = 128 + 256 + 512)
        self.fc = nn.Sequential(
            nn.Linear(896, 512),  # Changed from 512 to 896 input
            nn.ReLU(inplace=True),
            nn.Linear(512, emb_dim),
        )
        self.bn = nn.BatchNorm1d(emb_dim)

    def forward(self, patches: torch.Tensor) -> torch.Tensor:
        """
        Args:
            patches: (B, K, C_in) patch tensor where first 3 dims are XYZ (meters)
        Returns:
            embeddings: (B, emb_dim)
        """
        xyz = patches[..., :3]
        extra = patches[..., 3:] if patches.shape[-1] > 3 else None

        xyz1, feat1 = self.sa1(xyz, extra)   # micro: 0.10m, 128-D
        xyz2, feat2 = self.sa2(xyz1, feat1)  # meso: 0.50m, 256-D
        _, feat3 = self.sa3(xyz2, feat2)     # macro: 2.00m, 512-D

        # IMPROVED: Multi-scale feature fusion
        # Extract features from all three scales instead of just SA3
        global_feat1 = torch.max(feat1, dim=1).values  # (B, 128)
        global_feat2 = torch.max(feat2, dim=1).values  # (B, 256)
        global_feat3 = torch.max(feat3, dim=1).values  # (B, 512)

        # Concatenate multi-scale features (896-D total)
        global_feat = torch.cat([global_feat1, global_feat2, global_feat3], dim=-1)

        emb = self.fc(global_feat)
        emb = self.bn(emb)
        return emb


class ProjectionHead(nn.Module):
    """Two-layer MLP that projects embeddings for NT-Xent loss."""

    def __init__(self, emb_dim: int = 256, proj_dim: int = 128) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(emb_dim, emb_dim),
            nn.ReLU(inplace=True),
            nn.Linear(emb_dim, proj_dim),
        )

    def forward(self, emb: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.net(emb), dim=-1)


def nt_xent_loss(z_i: torch.Tensor, z_j: torch.Tensor, temperature: float = 0.2) -> torch.Tensor:
    """
    Normalized temperature-scaled cross entropy (SimCLR) loss.
    Positive pairs are (z_i[k], z_j[k]); all other pairs in batch are negatives.
    """
    batch_size = z_i.shape[0]
    z = torch.cat([z_i, z_j], dim=0)
    sim = torch.matmul(z, z.T) / temperature
    mask = torch.eye(2 * batch_size, dtype=torch.bool, device=z.device)
    fill_value = torch.finfo(sim.dtype).min if sim.dtype.is_floating_point else -1e9
    sim = sim.masked_fill(mask, fill_value)

    targets = torch.arange(batch_size, 2 * batch_size, device=z.device)
    targets = torch.cat([targets, torch.arange(batch_size, device=z.device)], dim=0)
    loss = F.cross_entropy(sim, targets)
    return loss


def nt_xent_loss_with_hard_negatives(
    z_i: torch.Tensor,
    z_j: torch.Tensor,
    temperature: float = 0.2,
    hard_negative_weight: float = 2.0,
) -> torch.Tensor:
    """
    IMPROVED: NT-Xent loss with hard negative mining.

    Emphasizes difficult negative samples (high similarity but not positive pairs)
    to force the model to learn more discriminative features.

    Args:
        z_i: (B, D) normalized projections of first view
        z_j: (B, D) normalized projections of second view
        temperature: scaling factor for similarities
        hard_negative_weight: weight multiplier for hard negatives (default: 2.0)
    Returns:
        loss: scalar contrastive loss with hard negative mining
    """
    batch_size = z_i.shape[0]
    z = torch.cat([z_i, z_j], dim=0)  # (2B, D)
    sim = torch.matmul(z, z.T) / temperature  # (2B, 2B)

    # Mask diagonal (self-similarities)
    mask = torch.eye(2 * batch_size, dtype=torch.bool, device=z.device)

    # Identify hard negatives (top 70th percentile of similarity among negatives)
    sim_negatives = sim.clone()
    sim_negatives[mask] = float('-inf')

    # Calculate threshold for hard negatives (only consider valid negatives)
    valid_negatives = sim_negatives[~mask]
    if valid_negatives.numel() > 0:
        # Ensure float dtype for quantile (may be float16 from mixed precision)
        threshold = torch.quantile(valid_negatives.float(), 0.7)
        hard_mask = (sim_negatives > threshold) & (~mask)
    else:
        hard_mask = torch.zeros_like(mask)

    # Create weight matrix: 1.0 for normal, hard_negative_weight for hard negatives
    weights = torch.ones_like(sim)
    weights[hard_mask] = hard_negative_weight

    # Compute weighted similarity
    exp_sim = torch.exp(sim) * weights
    exp_sim = exp_sim.masked_fill(mask, 0)  # Zero out diagonal

    # Positive pair targets
    targets = torch.cat([
        torch.arange(batch_size, 2 * batch_size, device=z.device),
        torch.arange(batch_size, device=z.device)
    ], dim=0)

    # Compute log probability for positive pairs
    log_prob = sim[range(2 * batch_size), targets] - torch.log(exp_sim.sum(dim=1) + 1e-8)
    loss = -log_prob.mean()

    return loss


__all__ = [
    "PointNet2Encoder",
    "ProjectionHead",
    "nt_xent_loss",
    "nt_xent_loss_with_hard_negatives",
    "PointNetSetAbstraction",
    "farthest_point_sample",
    "query_ball_point",
    "index_points",
    "square_distance",
]

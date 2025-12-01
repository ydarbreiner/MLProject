from __future__ import annotations

from typing import Callable, Tuple

import numpy as np
from sklearn.cluster import MiniBatchKMeans
from sklearn.metrics import silhouette_score

ClusterProgressCallback = Callable[[int, int, str], None]


def run_standard_kmeans(
    data: np.ndarray,
    k: int,
    max_iter: int,
    tol: float,
    seed: int,
    progress_callback: ClusterProgressCallback | None = None,
) -> Tuple[np.ndarray, np.ndarray, float, int]:
    rng = np.random.default_rng(seed)
    if data.shape[0] < k:
        raise ValueError(f"Requested {k} clusters but dataset only has {data.shape[0]} samples.")
    indices = rng.choice(data.shape[0], size=k, replace=False)
    centroids = data[indices].copy()
    labels = np.zeros(data.shape[0], dtype=np.int32)
    inertia = 0.0

    for iteration in range(1, max_iter + 1):
        distances = np.linalg.norm(data[:, None, :] - centroids[None, :, :], axis=2)
        labels = np.argmin(distances, axis=1).astype(np.int32)
        inertia = float(np.sum((data - centroids[labels]) ** 2))

        new_centroids = np.zeros_like(centroids)
        for idx in range(k):
            members = data[labels == idx]
            if members.size == 0:
                new_centroids[idx] = data[rng.integers(0, data.shape[0])]
            else:
                new_centroids[idx] = members.mean(axis=0)

        shift = float(np.linalg.norm(new_centroids - centroids))
        centroids = new_centroids

        if progress_callback:
            progress_callback(iteration, max_iter, f"KMeans iteration {iteration}/{max_iter} (shift={shift:.4f})")

        if shift < tol:
            return centroids, labels, inertia, iteration

    return centroids, labels, inertia, max_iter


def run_minibatch_kmeans(
    data: np.ndarray,
    k: int,
    max_iter: int,
    tol: float,
    seed: int,
    batch_size: int = 10_000,
    progress_callback: ClusterProgressCallback | None = None,
) -> Tuple[np.ndarray, np.ndarray, float, int]:
    num_samples = data.shape[0]
    if num_samples < k:
        raise ValueError(f"Requested {k} clusters but dataset only has {num_samples} samples.")

    batch_size = min(batch_size, num_samples)
    batch_size = max(batch_size, k)

    model = MiniBatchKMeans(
        n_clusters=k,
        max_iter=1,
        batch_size=batch_size,
        tol=tol,
        random_state=seed,
        n_init=1,
        init="k-means++",
    )

    rng = np.random.default_rng(seed)
    prev_centroids = None
    iterations_completed = 0

    for iteration in range(1, max_iter + 1):
        replace = num_samples < batch_size
        batch_indices = rng.choice(num_samples, size=batch_size, replace=replace)
        batch = data[batch_indices]
        model.partial_fit(batch)
        iterations_completed = iteration

        current_centroids = model.cluster_centers_.copy()
        if prev_centroids is not None:
            shift = float(np.linalg.norm(current_centroids - prev_centroids))
        else:
            shift = float("inf")
        prev_centroids = current_centroids

        if progress_callback:
            progress_callback(iteration, max_iter, f"MiniBatch iteration {iteration}/{max_iter} (shift={shift:.4f})")

        if shift < tol:
            break

    labels = model.predict(data)
    diffs = data - model.cluster_centers_[labels]
    inertia = float(np.sum((diffs) ** 2))
    return model.cluster_centers_, labels, inertia, iterations_completed


def find_optimal_clusters(
    embeddings: np.ndarray,
    k_range: Tuple[int, int] = (5, 30),
    sample_size: int = 10000,
    progress_callback: ClusterProgressCallback | None = None,
) -> int:
    """
    IMPROVED: Find optimal number of clusters using silhouette analysis.

    Tests multiple K values and selects the one with highest silhouette score,
    which measures how well-separated and cohesive clusters are.

    Args:
        embeddings: (N, D) embedding array
        k_range: (min_k, max_k) range of cluster counts to test
        sample_size: subsample size for efficiency (default: 10000)
        progress_callback: optional callback for progress updates
    Returns:
        best_k: optimal number of clusters
    """
    n_samples = embeddings.shape[0]

    # Sample for efficiency on large datasets
    if n_samples > sample_size:
        rng = np.random.default_rng(42)
        indices = rng.choice(n_samples, size=sample_size, replace=False)
        sample = embeddings[indices]
    else:
        sample = embeddings

    best_k = k_range[0]
    best_score = -1.0
    scores = {}

    print(f"Testing K from {k_range[0]} to {k_range[1]}...")

    for k in range(k_range[0], k_range[1] + 1):
        if progress_callback:
            progress_callback(
                k - k_range[0],
                k_range[1] - k_range[0],
                f"Testing k={k}"
            )

        # Cluster with current K using MiniBatchKMeans
        kmeans = MiniBatchKMeans(
            n_clusters=k,
            random_state=42,
            batch_size=min(1000, len(sample)),
            n_init=3,
        )
        labels = kmeans.fit_predict(sample)

        # Compute silhouette score (higher = better separation)
        # Sample again if dataset is very large to speed up silhouette computation
        silhouette_sample_size = min(5000, len(sample))
        score = silhouette_score(
            sample,
            labels,
            sample_size=silhouette_sample_size,
            random_state=42
        )
        scores[k] = score

        print(f"  K={k}: silhouette={score:.4f}")

        if score > best_score:
            best_score = score
            best_k = k

    print(f"\nOptimal K={best_k} with silhouette score={best_score:.4f}")
    print(f"Score distribution: min={min(scores.values()):.4f}, "
          f"max={max(scores.values()):.4f}, mean={np.mean(list(scores.values())):.4f}")

    return best_k


__all__ = [
    "run_standard_kmeans",
    "run_minibatch_kmeans",
    "find_optimal_clusters",
    "ClusterProgressCallback"
]

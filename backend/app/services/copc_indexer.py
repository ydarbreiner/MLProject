from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, Mapping, MutableMapping, Optional, Set, Tuple

import logging

import laspy  # type: ignore

try:
    import copclib as copc  # type: ignore
except ImportError:  # pragma: no cover - runtime dependency
    copc = None

logger = logging.getLogger(__name__)

ClusterOverrideIndex = Dict[int, Tuple[str, int]]


@dataclass
class CopcIndexResolver:
    """Resolves LAS point indices to COPC tile/local indices using the OriginalPointId extra dimension."""

    copc_path: Path
    dimension_name: str = "OriginalPointId"

    def __post_init__(self) -> None:
        if not self.copc_path.exists():
            raise FileNotFoundError(f"COPC file not found: {self.copc_path}")
        if copc is None:  # pragma: no cover - import guard
            raise RuntimeError("copclib is required to build COPC tile indexes.")
        self._extra_offset: Optional[int] = None
        self._extra_size: Optional[int] = None

    def resolve_points(self, point_ids: Iterable[int]) -> ClusterOverrideIndex:
        """Resolve a collection of LAS point ids to (tile_key, local_index) tuples."""
        targets: Set[int] = {int(pid) for pid in point_ids}
        if not targets:
            return {}

        offset, size = self._resolve_extra_dimension()
        reader = copc.FileReader(str(self.copc_path))
        remaining = set(targets)
        resolved: ClusterOverrideIndex = {}

        for node in reader.GetAllNodes():
            if not remaining:
                break
            tile_key = self._format_tile_key(node.key)
            points = reader.GetPoints(node)
            for local_index, point in enumerate(points):
                raw = getattr(point, "extra_bytes", None)
                if not raw:
                    continue
                if len(raw) < offset + size:
                    continue
                value = int.from_bytes(bytes(raw[offset:offset + size]), byteorder="little", signed=False)
                if value in remaining:
                    resolved[value] = (tile_key, local_index)
                    remaining.remove(value)
                    if not remaining:
                        break

        if remaining:
            logger.warning(
                "Failed to resolve %d point ids for COPC %s. Overlay output may be incomplete.",
                len(remaining),
                self.copc_path,
            )

        return resolved

    def _resolve_extra_dimension(self) -> Tuple[int, int]:
        if self._extra_offset is not None and self._extra_size is not None:
            return self._extra_offset, self._extra_size

        with laspy.open(self.copc_path) as handle:
            offset = 0
            # Check if extra dimensions exist (laspy 2.x compatibility)
            extra_dims = getattr(handle.header.point_format, 'extra_dimensions', [])
            if not extra_dims:
                extra_dims = getattr(handle.header, 'extra_dimensions', [])

            for dimension in extra_dims:
                dim_size = dimension.num_elements * dimension.dtype.itemsize
                if dimension.name == self.dimension_name:
                    self._extra_offset = offset
                    self._extra_size = dim_size
                    return offset, dim_size
                offset += dim_size

        raise RuntimeError(
            f"{self.dimension_name} dimension not found in COPC file {self.copc_path}. "
            "Ensure point clouds are converted with filters.assign OriginalPointId."
        )

    @staticmethod
    def _format_tile_key(key: "copc.VoxelKey") -> str:
        return f"{key.d}/{key.x}/{key.y}/{key.z}"


def aggregate_cluster_assignments(
    mapping: Mapping[int, Tuple[str, int]],
    assignments: Mapping[int, int],
) -> Dict[str, Dict[int, Dict[int, int]]]:
    """Aggregate per-point cluster votes by tile and local index."""
    tile_votes: Dict[str, Dict[int, Dict[int, int]]] = defaultdict(lambda: defaultdict(dict))
    for point_id, cluster_id in assignments.items():
        tile_info = mapping.get(point_id)
        if not tile_info:
            continue
        tile_key, local_index = tile_info
        counter = tile_votes[tile_key].setdefault(local_index, {})
        counter[cluster_id] = counter.get(cluster_id, 0) + 1
    return tile_votes

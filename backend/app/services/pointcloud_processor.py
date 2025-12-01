import os
import json
from collections import Counter
from typing import Any, Dict, Optional, Tuple
import laspy
import numpy as np
import pdal

try:
    import copclib as copc
except ImportError:
    copc = None

try:
    from pyproj import CRS, Transformer  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    CRS = None  # type: ignore[assignment]
    Transformer = None  # type: ignore[assignment]

try:
    from shapely.geometry import MultiPoint
    from shapely.geometry import mapping as shapely_mapping
except ImportError:  # pragma: no cover - optional dependency
    MultiPoint = None  # type: ignore[assignment]
    shapely_mapping = None  # type: ignore[assignment]

try:
    from shapely.ops import transform as shapely_transform
except ImportError:  # pragma: no cover - optional dependency
    shapely_transform = None  # type: ignore[assignment]

try:
    from shapely import concave_hull
except ImportError:  # pragma: no cover - optional dependency
    concave_hull = None  # type: ignore[assignment]

from app.core.config import settings

class PointCloudProcessor:
    def __init__(self):
        self.metadata: Dict[str, Any] = {}
        self.error_message: Optional[str] = None
        self.source_crs: Optional[Any] = None

    async def process_las_to_copc(self, input_file: str, pointcloud_id: int, name: str, db_session=None) -> bool:
        """
        Process LAS file: LAS → COPC (direct conversion)
        """
        try:
            print(f"🔄 Starting LAS → COPC conversion for {name}")

            # Create output directory
            output_dir = os.path.join(settings.pointcloud_output_dir, str(pointcloud_id))
            os.makedirs(output_dir, exist_ok=True)

            # Gather metadata without loading entire file in memory
            header = self._read_header(input_file)
            classification_stats = self._collect_classification_stats(input_file)
            self.metadata = self._build_metadata(header, classification_stats)

            # Auto-generate colors for new classifications
            if db_session and classification_stats:
                self._ensure_classification_colors(classification_stats, db_session)

            footprint = self._compute_footprint_geojson(input_file, self.source_crs)
            if footprint is not None:
                self.metadata['footprint'] = footprint

            # Direct LAS to COPC conversion
            copc_file = os.path.join(output_dir, "data.copc.laz")
            print(f"🌐 Converting LAS to COPC: {copc_file}")
            success_copc = await self._convert_las_to_copc_direct(input_file, copc_file)

            if success_copc:
                print(f"✅ LAS → COPC conversion completed: {copc_file}")
                return True
            else:
                print(f"❌ COPC conversion failed")
                return False

        except Exception as e:
            print(f"💥 Error processing point cloud: {str(e)}")
            self.error_message = str(e)
            return False

    async def _compress_las_to_laz(self, input_file: str, output_file: str) -> bool:
        """Compress LAS to LAZ format using PDAL in streaming mode."""
        try:
            header = self._read_header(input_file)
            classification_stats = self._collect_classification_stats(input_file)
            self.metadata = self._build_metadata(header, classification_stats)

            pipeline_definition = {
                "pipeline": [
                    {
                        "type": "readers.las",
                        "filename": input_file
                    },
                    {
                        "type": "writers.las",
                        "filename": output_file,
                        "compression": "laszip"
                    }
                ],
                "stream": True,
            }

            pipeline = pdal.Pipeline(json.dumps(pipeline_definition))
            print(f"🔄 Compressing LAS → LAZ: {output_file}")
            pipeline.execute()

            if pipeline.log:
                print(f"📝 PDAL log output:\n{pipeline.log}")

            print(f"✅ LAZ compression completed: {output_file}")
            return True

        except Exception as e:
            print(f"❌ LAZ compression failed: {str(e)}")
            self.error_message = str(e)
            return False

    async def _convert_laz_to_copc(self, laz_file: str, copc_file: str) -> bool:
        """Convert LAZ to COPC format using copclib"""
        try:
            if copc is None:
                raise RuntimeError("copclib is not installed; LAZ→COPC conversion via copclib is unavailable.")

            print(f"🌐 Converting LAZ to COPC using copclib...")

            # Read LAZ file with laspy to get header info
            las_data = laspy.read(laz_file)
            header = las_data.header

            # COPC requires point formats 6-8, convert if necessary
            original_format = header.point_format.id
            target_format = 6 if original_format < 6 else original_format

            print(f"📋 Original point format: {original_format}, Converting to: {target_format}")

            # Convert point format if needed
            if original_format != target_format:
                # Convert to point format 6
                las_data.point_format = target_format
                print(f"🔄 Converted from point format {original_format} to {target_format}")

            # Create COPC config with required parameters
            config = copc.CopcConfigWriter(
                point_format_id=target_format,
                scale=copc.Vector3(header.scales[0], header.scales[1], header.scales[2]),
                offset=copc.Vector3(header.offsets[0], header.offsets[1], header.offsets[2])
            )

            # Create COPC writer
            writer = copc.FileWriter(copc_file, config)

            # Convert points to COPC format
            points = copc.Points.from_buffer(las_data.points_data.tobytes(), target_format)

            # Add root node with all points
            root_key = copc.VoxelKey(0, 0, 0, 0)  # Root node
            writer.AddNode(root_key, points)

            # Close writer
            writer.Close()

            print(f"✅ COPC conversion completed: {copc_file}")
            return True

        except Exception as e:
            print(f"❌ COPC conversion failed: {str(e)}")
            self.error_message = str(e)
            return False

    async def _convert_las_to_copc_direct(self, input_file: str, copc_file: str) -> bool:
        """Convert LAS directly to COPC format using PDAL"""
        try:
            print(f"🌐 Converting LAS to COPC using PDAL...")

            # Simple PDAL pipeline: LAS → COPC
            # Standard LAS dimensions (including UserData) are preserved automatically
            pipeline_definition = {
                "pipeline": [
                    {
                        "type": "readers.las",
                        "filename": input_file
                    },
                    {
                        "type": "writers.copc",
                        "filename": copc_file,
                        "forward": "all"
                    }
                ],
                "stream": True,
            }

            pipeline = pdal.Pipeline(json.dumps(pipeline_definition))

            print(f"🔄 Executing PDAL pipeline...")
            point_count = pipeline.execute()

            if pipeline.log:
                print(f"📝 PDAL log output:\n{pipeline.log}")

            print(f"✅ COPC conversion completed: {copc_file}")
            print(f"📊 Processed {point_count:,} points")
            return True

        except Exception as e:
            error_message = str(e)
            try:
                if 'pipeline' in locals():
                    log_output = getattr(pipeline, 'log', '')
                    if log_output:
                        error_message = f"{error_message}\n{log_output}"
            except Exception:
                pass

            print(f"❌ COPC conversion failed: {error_message}")
            self.error_message = error_message
            return False

    def _read_header(self, input_file: str):
        """Read LAS header without loading point data"""
        try:
            with laspy.open(input_file) as las_reader:
                return las_reader.header
        except Exception as exc:
            print(f"⚠️ Unable to read LAS header: {exc}")
            raise

    def _collect_classification_stats(self, input_file: str) -> Dict[int, int]:
        """Collect classification counts using chunked iteration via laspy."""
        try:
            with laspy.open(input_file) as reader:
                header = reader.header
                point_format = header.point_format
                if "classification" not in point_format.dimension_names:
                    return {}

                counts: Counter[int] = Counter()
                chunk_size = 1_000_000  # keep memory bounded while iterating
                for points in reader.chunk_iterator(chunk_size):
                    classifications = np.asarray(points["classification"], dtype=np.uint8)
                    if classifications.size == 0:
                        continue
                    bin_counts = np.bincount(classifications, minlength=256)
                    for class_id, count in enumerate(bin_counts):
                        if count:
                            counts[class_id] += int(count)

            return dict(counts)
        except Exception as exc:
            print(f"⚠️ Failed to collect classification stats: {exc}")
            return {}

    def _ensure_classification_colors(self, classification_stats: Dict[int, int], db_session) -> None:
        """Auto-generate colors for any classifications not in the global scheme"""
        from app.models.classification_color_scheme import ClassificationColorScheme

        # Get existing color schemes
        existing = db_session.query(ClassificationColorScheme.classification_value).all()
        existing_values = {row[0] for row in existing}

        # Find new classifications
        new_values = set(classification_stats.keys()) - existing_values

        if not new_values:
            return

        print(f"🎨 Auto-generating colors for {len(new_values)} new classifications: {sorted(new_values)}")

        # Standard ASPRS classification names
        classification_names = {
            0: "Never classified", 1: "Unassigned", 2: "Ground",
            3: "Low vegetation", 4: "Medium vegetation", 5: "High vegetation",
            6: "Building", 7: "Low point", 8: "Model key-point", 9: "Water",
            10: "Rail", 11: "Road surface", 12: "Overlap points",
            13: "Wire - guard", 14: "Wire - conductor", 15: "Transmission tower",
            16: "Wire-structure connector", 17: "Bridge deck", 18: "High noise"
        }

        # Golden angle color generation (same as cluster colors)
        for idx, class_value in enumerate(sorted(new_values)):
            hue = (idx * 137.5) % 360  # Golden angle
            saturation = 0.85
            lightness = 0.55

            # Convert HSL to RGB
            rgb = self._hsl_to_rgb(hue / 360, saturation, lightness)
            hex_color = f"#{int(rgb[0]*255):02x}{int(rgb[1]*255):02x}{int(rgb[2]*255):02x}"

            name = classification_names.get(class_value, f"Class {class_value}")

            new_scheme = ClassificationColorScheme(
                classification_value=class_value,
                name=name,
                color=hex_color.upper(),
                auto_generated=True
            )
            db_session.add(new_scheme)

        db_session.commit()
        print(f"✅ Created {len(new_values)} new classification color schemes")

    def _hsl_to_rgb(self, h: float, s: float, l: float) -> Tuple[float, float, float]:
        """Convert HSL to RGB (values 0-1)"""
        def hue_to_rgb(p: float, q: float, t: float) -> float:
            if t < 0: t += 1
            if t > 1: t -= 1
            if t < 1/6: return p + (q - p) * 6 * t
            if t < 1/2: return q
            if t < 2/3: return p + (q - p) * (2/3 - t) * 6
            return p

        if s == 0:
            return (l, l, l)

        q = l * (1 + s) if l < 0.5 else l + s - l * s
        p = 2 * l - q
        r = hue_to_rgb(p, q, h + 1/3)
        g = hue_to_rgb(p, q, h)
        b = hue_to_rgb(p, q, h - 1/3)
        return (r, g, b)

    def _compute_footprint_geojson(self, input_file: str, crs: Optional[Any]) -> Optional[Dict[str, Any]]:
        """
        Build an approximate flight footprint polygon by sampling XY points and computing a concave hull.
        Returns GeoJSON geometry in EPSG:4326 when CRS conversion is available.
        """
        if MultiPoint is None or shapely_mapping is None:
            return None

        max_total_points = 50000
        max_points_per_chunk = 5000
        sample_arrays: list[np.ndarray] = []
        total_samples = 0

        try:
            with laspy.open(input_file) as reader:
                for chunk in reader.chunk_iterator(250_000):
                    xs = np.asarray(chunk.x, dtype=np.float64)
                    ys = np.asarray(chunk.y, dtype=np.float64)
                    if xs.size == 0 or ys.size == 0:
                        continue

                    coords = np.column_stack((xs, ys))
                    if coords.shape[0] > max_points_per_chunk:
                        step = max(1, coords.shape[0] // max_points_per_chunk)
                        coords = coords[::step]

                    sample_arrays.append(coords)
                    total_samples += coords.shape[0]
                    if total_samples >= max_total_points:
                        break

        except Exception as exc:
            print(f"⚠️ Unable to sample points for footprint: {exc}")
            return None

        if not sample_arrays:
            return None

        samples = np.vstack(sample_arrays)
        if samples.shape[0] > max_total_points:
            indices = np.linspace(0, samples.shape[0] - 1, max_total_points, dtype=int)
            samples = samples[indices]

        multipoint = MultiPoint(samples)
        if multipoint.is_empty:
            return None

        hull = None
        if concave_hull is not None:
            try:
                hull = concave_hull(multipoint, 0.05, allow_holes=True)
            except Exception as exc:
                print(f"⚠️ Concave hull computation failed: {exc}")

        if hull is None or hull.is_empty:
            hull = multipoint.convex_hull

        if hull.is_empty:
            return None

        if shapely_transform is None or Transformer is None or crs is None:
            return None

        try:
            transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)  # type: ignore[arg-type]
            hull = shapely_transform(lambda x, y, z=None: transformer.transform(x, y), hull)
        except Exception as exc:
            print(f"⚠️ Failed to transform footprint to WGS84: {exc}")
            return None

        simplified = hull.simplify(0.00005, preserve_topology=True)
        geometry = simplified if not simplified.is_empty else hull

        if geometry.is_empty:
            return None

        if geometry.geom_type not in ("Polygon", "MultiPolygon"):
            geometry = geometry.convex_hull
            if geometry.is_empty or geometry.geom_type not in ("Polygon", "MultiPolygon"):
                return None

        try:
            return shapely_mapping(geometry)
        except Exception as exc:
            print(f"⚠️ Failed to serialize footprint geometry: {exc}")
            return None

    def _build_metadata(self, header, classification_stats: Dict[int, int]) -> Dict[str, Any]:
        """Assemble metadata from LAS header and classification histogram"""
        try:
            mins = getattr(header, "mins", None)
            maxs = getattr(header, "maxs", None)

            if mins is None:
                mins = (
                    float(getattr(header, "min_x", 0.0)),
                    float(getattr(header, "min_y", 0.0)),
                    float(getattr(header, "min_z", 0.0)),
                )
            if maxs is None:
                maxs = (
                    float(getattr(header, "max_x", 0.0)),
                    float(getattr(header, "max_y", 0.0)),
                    float(getattr(header, "max_z", 0.0)),
                )

            bounds_min = {
                'x': float(mins[0]),
                'y': float(mins[1]),
                'z': float(mins[2]),
            }
            bounds_max = {
                'x': float(maxs[0]),
                'y': float(maxs[1]),
                'z': float(maxs[2]),
            }

            bounds: Dict[str, Any] = {
                'min': bounds_min,
                'max': bounds_max,
            }

            crs = self._parse_crs(header)
            self.source_crs = crs
            coordinate_system = self._format_crs(crs)
            if coordinate_system:
                bounds['coordinateSystem'] = coordinate_system

            geographic_bounds = self._compute_geographic_bounds(bounds_min, bounds_max, crs)
            if geographic_bounds:
                bounds['geographic'] = geographic_bounds

            metadata: Dict[str, Any] = {
                'point_count': getattr(header, "point_count", 0),
                'bounds': bounds,
            }

            if classification_stats:
                classification_map = self._map_classification_names(classification_stats)
                metadata['classification'] = classification_map

            return metadata
        except Exception as exc:
            print(f"⚠️ Error assembling metadata: {exc}")
            return {
                'point_count': 0,
                'bounds': None,
                'classification': {}
            }

    def _map_classification_names(self, stats: Dict[int, int]) -> Dict[str, int]:
        """Translate classification ids to human readable names."""
        classification_map = {
            0: "Never classified",
            1: "Unassigned",
            2: "Ground",
            3: "Low vegetation",
            4: "Medium vegetation",
            5: "High vegetation",
            6: "Building",
            7: "Low point",
            8: "Model key-point",
            9: "Water",
            10: "Rail",
            11: "Road surface",
            12: "Overlap points",
            13: "Wire - guard",
            14: "Wire - conductor",
            15: "Transmission tower",
            16: "Wire-structure connector",
            17: "Bridge deck",
            18: "High noise",
        }
        mapped: Dict[str, int] = {}
        for class_id, count in stats.items():
            name = classification_map.get(class_id, f"Class {class_id}")
            mapped[name] = count
        return mapped

    def get_metadata(self) -> Dict[str, Any]:
        """Get extracted metadata"""
        return self.metadata

    def get_error_message(self) -> Optional[str]:
        """Get error message if processing failed"""
        return self.error_message

    def _parse_crs(self, header) -> Optional[Any]:
        """Attempt to parse CRS information from the LAS header."""
        if CRS is None:
            return None
        try:
            return header.parse_crs()
        except Exception as exc:  # pragma: no cover - informative logging
            print(f"⚠️ Unable to parse CRS from LAS header: {exc}")
            return None

    def _format_crs(self, crs: Optional[Any]) -> Optional[str]:
        """Return a compact CRS identifier such as EPSG codes when available."""
        if crs is None:
            return None
        try:
            if hasattr(crs, "to_authority"):
                authority: Optional[Tuple[str, str]] = crs.to_authority()  # type: ignore[attr-defined]
            else:
                authority = None
            if authority and authority[0] and authority[1]:
                return f"{authority[0]}:{authority[1]}"
            name = getattr(crs, "name", None)
            if isinstance(name, str) and name:
                return name
            return str(crs)
        except Exception as exc:  # pragma: no cover - safety
            print(f"⚠️ Unable to format CRS: {exc}")
            return None

    def _compute_geographic_bounds(
        self,
        bounds_min: Dict[str, float],
        bounds_max: Dict[str, float],
        crs: Optional[Any],
    ) -> Optional[Dict[str, Dict[str, float]]]:
        """
        Convert native coordinate bounds to geographic (lat/lng) bounds using pyproj when available.
        """
        if Transformer is None or crs is None:
            return None

        try:
            transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)  # type: ignore[arg-type]
        except Exception as exc:
            print(f"⚠️ Unable to construct transformer for CRS conversion: {exc}")
            return None

        corners = [
            (bounds_min['x'], bounds_min['y']),
            (bounds_min['x'], bounds_max['y']),
            (bounds_max['x'], bounds_min['y']),
            (bounds_max['x'], bounds_max['y']),
        ]

        try:
            transformed = [transformer.transform(x, y) for x, y in corners]
        except Exception as exc:
            print(f"⚠️ Failed to transform bounds to geographic coordinates: {exc}")
            return None

        longitudes = [lon for lon, _ in transformed]
        latitudes = [lat for _, lat in transformed]

        if not longitudes or not latitudes:
            return None

        south_west = {
            'lat': min(latitudes),
            'lng': min(longitudes),
        }
        north_east = {
            'lat': max(latitudes),
            'lng': max(longitudes),
        }

        return {
            'southWest': south_west,
            'northEast': north_east,
        }

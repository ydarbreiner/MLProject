from __future__ import annotations
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from xml.etree import ElementTree as ET

from shapely.geometry import (
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPoint,
    MultiPolygon,
    Point,
    Polygon,
)
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union


class KMLParserError(Exception):
    """Raised when a KML or KMZ file cannot be processed."""


@dataclass
class KMLParseResult:
    poles: List[Dict[str, Optional[Any]]]
    geometry: Optional[Dict]
    centroid: Optional[Dict[str, float]]
    total_features: int
    pole_count: int


def parse_kml_file(file_path: str) -> KMLParseResult:
    """Parse a KML/KMZ file and return extracted pole and geometry data."""

    try:
        data = _read_kml_bytes(file_path)
    except Exception as exc:  # pragma: no cover - safety net
        raise KMLParserError(f"Unable to read KML data: {exc}") from exc

    try:
        document = ET.fromstring(data)
    except ET.ParseError as exc:
        raise KMLParserError(f"Invalid KML content: {exc}") from exc

    point_geometries: List[Point] = []
    other_geometries: List[BaseGeometry] = []
    poles: List[Dict[str, Optional[str]]] = []
    total_features = 0

    for placemark in document.findall(".//{http://www.opengis.net/kml/2.2}Placemark"):
        name = _text_value(placemark.find("{http://www.opengis.net/kml/2.2}name"))
        geometry_nodes = list(_iter_geometry_elements(placemark))
        if not geometry_nodes:
            continue

        for geometry_node in geometry_nodes:
            shapely_geometries = _geometries_from_node(geometry_node)
            if not shapely_geometries:
                continue
            total_features += len(shapely_geometries)
            for geom in shapely_geometries:
                if isinstance(geom, Point):
                    poles.append(
                        {
                            "lat": geom.y,
                            "lng": geom.x,
                            "name": name,
                            "alt": geom.z if geom.has_z else None,
                        }
                    )
                    point_geometries.append(geom)
                elif isinstance(geom, MultiPoint):
                    for pt in geom.geoms:
                        poles.append(
                            {
                                "lat": pt.y,
                                "lng": pt.x,
                                "name": name,
                                "alt": pt.z if pt.has_z else None,
                            }
                        )
                        point_geometries.append(pt)
                elif isinstance(geom, GeometryCollection):
                    for sub_geom in geom.geoms:
                        if isinstance(sub_geom, Point):
                            poles.append(
                                {
                                    "lat": sub_geom.y,
                                    "lng": sub_geom.x,
                                    "name": name,
                                    "alt": sub_geom.z if sub_geom.has_z else None,
                                }
                            )
                            point_geometries.append(sub_geom)
                        else:
                            other_geometries.append(sub_geom)
                else:
                    other_geometries.append(geom)

    project_geometry = _build_project_geometry(point_geometries, other_geometries)
    centroid = None
    if project_geometry is not None and not project_geometry.is_empty:
        centroid_geom = project_geometry.centroid
        centroid = {"lat": centroid_geom.y, "lng": centroid_geom.x}

    return KMLParseResult(
        poles=poles,
        geometry=mapping(project_geometry) if project_geometry is not None else None,
        centroid=centroid,
        total_features=total_features,
        pole_count=len(poles),
    )


def _read_kml_bytes(file_path: str) -> bytes:
    if file_path.lower().endswith(".kmz"):
        with zipfile.ZipFile(file_path, "r") as archive:
            for name in archive.namelist():
                if name.lower().endswith(".kml"):
                    with archive.open(name) as file_obj:
                        return file_obj.read()
        raise KMLParserError("KMZ file does not contain a KML entry")

    with open(file_path, "rb") as file_obj:
        return file_obj.read()


def _iter_geometry_elements(node: ET.Element) -> Iterable[ET.Element]:
    """Yield geometry nodes beneath the provided element."""
    for child in list(node):
        if _local_name(child.tag) in _GEOMETRY_TAGS:
            yield child
        else:
            yield from _iter_geometry_elements(child)


def _geometries_from_node(node: ET.Element) -> List[BaseGeometry]:
    tag = _local_name(node.tag)

    if tag == "Point":
        coords = _parse_coordinates(_text_value(node.find(_qualify("coordinates"))))
        return [Point(coords[0])] if coords else []

    if tag == "LineString":
        coords = _parse_coordinates(_text_value(node.find(_qualify("coordinates"))))
        return [LineString(coords)] if len(coords) >= 2 else []

    if tag == "LinearRing":
        coords = _parse_coordinates(_text_value(node.find(_qualify("coordinates"))))
        return [Polygon(coords)] if len(coords) >= 3 else []

    if tag == "Polygon":
        outer = _parse_coordinates(
            _text_value(
                node.find(f"{_qualify('outerBoundaryIs')}/{_qualify('LinearRing')}/{_qualify('coordinates')}")
            )
        )
        holes: List[Sequence[Tuple[float, float]]] = []
        for inner in node.findall(f"{_qualify('innerBoundaryIs')}/{_qualify('LinearRing')}/{_qualify('coordinates')}"):
            ring = _parse_coordinates(_text_value(inner))
            if len(ring) >= 3:
                holes.append(ring)
        return [Polygon(outer, holes)] if len(outer) >= 3 else []

    if tag == "MultiGeometry":
        geoms: List[BaseGeometry] = []
        for child in node:
            geoms.extend(_geometries_from_node(child))
        return geoms

    if tag == "MultiPoint":
        geoms: List[BaseGeometry] = []
        for point_node in node.findall(_qualify("Point")):
            geoms.extend(_geometries_from_node(point_node))
        return geoms

    if tag == "MultiLineString":
        geoms: List[BaseGeometry] = []
        for line_node in node.findall(_qualify("LineString")):
            geoms.extend(_geometries_from_node(line_node))
        return geoms

    if tag == "MultiPolygon":
        geoms: List[BaseGeometry] = []
        for polygon_node in node.findall(_qualify("Polygon")):
            geoms.extend(_geometries_from_node(polygon_node))
        return geoms

    if tag == "GeometryCollection":
        geoms: List[BaseGeometry] = []
        for child in node:
            geoms.extend(_geometries_from_node(child))
        return geoms

    return []


def _build_project_geometry(points: List[Point], others: List[BaseGeometry]) -> Optional[BaseGeometry]:
    geometries = [geom for geom in others if geom is not None and not geom.is_empty]

    if geometries:
        return unary_union(geometries)

    if points:
        combined = unary_union(points)
        if combined.geom_type == "Point":
            return combined.buffer(0.0001)
        return combined.convex_hull

    return None


def _parse_coordinates(text: Optional[str]) -> List[Tuple[float, ...]]:
    if not text:
        return []

    coords: List[Tuple[float, ...]] = []
    for raw_pair in text.replace("\n", " ").split():
        parts = raw_pair.strip().split(",")
        if len(parts) < 2:
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
            alt = float(parts[2]) if len(parts) > 2 and parts[2].strip() else None
        except ValueError:
            continue
        if alt is not None:
            coords.append((lon, lat, alt))
        else:
            coords.append((lon, lat))
    return coords


def _text_value(element: Optional[ET.Element]) -> Optional[str]:
    if element is None or element.text is None:
        return None
    value = element.text.strip()
    return value if value else None


def _local_name(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _qualify(tag: str) -> str:
    return f"{{{_KML_NAMESPACE}}}{tag}"


_KML_NAMESPACE = "http://www.opengis.net/kml/2.2"
_GEOMETRY_TAGS = {
    "Point",
    "LineString",
    "LinearRing",
    "Polygon",
    "MultiGeometry",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
}

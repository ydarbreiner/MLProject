#!/usr/bin/env python3
"""
Regenerate footprints for existing point clouds with improved concave hull parameters.
This script reads from COPC files and recomputes the footprint with better accuracy.
"""

import sys
from pathlib import Path

# Add app directory to path
sys.path.insert(0, str(Path(__file__).parent))

from app.core.database import SessionLocal
from app.models.pointcloud import PointCloud, ProcessingStatus
from app.services.pointcloud_processor import PointCloudProcessor

def regenerate_footprints():
    """Regenerate footprints for all completed point clouds."""
    db = SessionLocal()

    try:
        # Get all completed point clouds
        point_clouds = db.query(PointCloud).filter(
            PointCloud.status == ProcessingStatus.COMPLETED
        ).all()

        print(f"Found {len(point_clouds)} completed point clouds")

        for pc in point_clouds:
            print(f"\nProcessing: {pc.name} (ID: {pc.id})")

            # Construct path to COPC file
            copc_path = Path(f"pointclouds/{pc.id}/data.copc.laz")

            if not copc_path.exists():
                print(f"  ⚠️  COPC file not found: {copc_path}")
                continue

            try:
                # Create a processor instance
                processor = PointCloudProcessor()

                # Try to get CRS from existing bounds
                crs = None
                if pc.bounds and pc.bounds.get('coordinateSystem'):
                    crs_string = pc.bounds['coordinateSystem']
                    # Extract EPSG code from string like "UTM 13N (EPSG:32613)"
                    import re
                    match = re.search(r'EPSG:(\d+)', crs_string)
                    if match:
                        try:
                            from pyproj import CRS
                            crs = CRS.from_epsg(int(match.group(1)))
                            print(f"  Using CRS: {crs_string}")
                        except Exception as e:
                            print(f"  ⚠️  Could not load CRS: {e}")
                            crs = None

                # Compute footprint from COPC file
                print(f"  Computing footprint with improved parameters...")
                footprint = processor._compute_footprint_geojson(
                    str(copc_path),
                    crs
                )

                if footprint:
                    # Update in database
                    pc.footprint = footprint
                    db.commit()

                    footprint_type = footprint.get('type', 'unknown')
                    coords_count = len(footprint.get('coordinates', [[]])[0]) if footprint_type == 'Polygon' else 0
                    print(f"  ✓ Updated footprint ({footprint_type} with {coords_count} vertices)")
                else:
                    print(f"  ⚠️  Failed to compute footprint")

            except Exception as e:
                print(f"  ✗ Error: {e}")
                db.rollback()
                continue

        print(f"\n✓ Finished regenerating footprints")

    finally:
        db.close()

if __name__ == "__main__":
    print("=" * 60)
    print("Regenerating Footprints for Existing Point Clouds")
    print("=" * 60)
    print("\nOriginal Algorithm (Restored from git):")
    print("  • Using Shapely concave_hull (ratio=0.05, allow_holes=True)")
    print("  • 50,000 sample points")
    print("\n" + "=" * 60 + "\n")
    regenerate_footprints()

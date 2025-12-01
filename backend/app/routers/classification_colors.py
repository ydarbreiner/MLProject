from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.models.classification_color_scheme import ClassificationColorScheme
from app.models.pointcloud import PointCloud
from pydantic import BaseModel
from typing import List


router = APIRouter(prefix="/api/classification-colors", tags=["classification-colors"])


class ColorSchemeUpdate(BaseModel):
    color: str  # Hex color


class ColorSchemeResponse(BaseModel):
    classification_value: int
    name: str
    color: str
    auto_generated: bool

    class Config:
        from_attributes = True  # For Pydantic v2 (formerly orm_mode = True)


@router.get("/", response_model=List[ColorSchemeResponse])
def get_all_color_schemes(db: Session = Depends(get_db)):
    """Get all classification color schemes"""
    schemes = db.query(ClassificationColorScheme).order_by(
        ClassificationColorScheme.classification_value
    ).all()
    return schemes


@router.get("/{classification_value}", response_model=ColorSchemeResponse)
def get_color_scheme(classification_value: int, db: Session = Depends(get_db)):
    """Get color scheme for a specific classification"""
    scheme = db.query(ClassificationColorScheme).filter(
        ClassificationColorScheme.classification_value == classification_value
    ).first()
    if not scheme:
        raise HTTPException(status_code=404, detail="Classification color scheme not found")
    return scheme


@router.patch("/{classification_value}")
def update_color_scheme(
    classification_value: int,
    update: ColorSchemeUpdate,
    db: Session = Depends(get_db)
):
    """Update color for a classification (globally)"""
    scheme = db.query(ClassificationColorScheme).filter(
        ClassificationColorScheme.classification_value == classification_value
    ).first()

    if not scheme:
        raise HTTPException(status_code=404, detail="Classification not found")

    scheme.color = update.color
    scheme.auto_generated = False  # Mark as user-customized
    db.commit()
    db.refresh(scheme)

    return {"success": True, "scheme": scheme}


@router.get("/pointcloud/{pointcloud_id}", response_model=List[ColorSchemeResponse])
def get_pointcloud_classifications(pointcloud_id: int, db: Session = Depends(get_db)):
    """Get color schemes for classifications that exist in a specific point cloud"""
    pointcloud = db.query(PointCloud).filter(PointCloud.id == pointcloud_id).first()
    if not pointcloud:
        raise HTTPException(status_code=404, detail="Point cloud not found")

    if not pointcloud.classification:
        return []

    # Extract classification names from the classification metadata
    # Format: {"Ground": 123456, "Building": 78910, ...}
    classification_names = set(pointcloud.classification.keys())

    # Get all schemes
    all_schemes = db.query(ClassificationColorScheme).all()

    # Match by name (since metadata uses names as keys)
    # Use case-insensitive matching for better compatibility
    matching_schemes = []
    for scheme in all_schemes:
        scheme_name_lower = scheme.name.lower()
        for pc_name in classification_names:
            pc_name_lower = pc_name.lower()
            # Match if names contain each other (flexible matching)
            if scheme_name_lower in pc_name_lower or pc_name_lower in scheme_name_lower:
                matching_schemes.append(scheme)
                break

    return matching_schemes

from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.sql import func
from app.core.database import Base


class ClassificationColorScheme(Base):
    """
    Global classification color scheme table.
    Stores color mappings for LiDAR classification values (0-255).
    """
    __tablename__ = "classification_color_schemes"

    id = Column(Integer, primary_key=True, index=True)
    classification_value = Column(Integer, nullable=False, unique=True, index=True)  # 0-255
    name = Column(String, nullable=False)  # "Ground", "Building", etc.
    color = Column(String, nullable=False)  # Hex color: "#8B4513"
    auto_generated = Column(Boolean, default=False)  # True if color was auto-assigned
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

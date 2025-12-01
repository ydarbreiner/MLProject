from sqlalchemy import Column, Integer, String, DateTime, Float, ForeignKey, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.core.database import Base

class Measurement(Base):
    __tablename__ = "measurements"

    id = Column(Integer, primary_key=True, index=True)
    pointcloud_id = Column(Integer, ForeignKey("pointclouds.id", ondelete="CASCADE"), nullable=False, index=True)

    # Store the two 3D points that define the measurement
    point1_x = Column(Float, nullable=False)
    point1_y = Column(Float, nullable=False)
    point1_z = Column(Float, nullable=False)

    point2_x = Column(Float, nullable=False)
    point2_y = Column(Float, nullable=False)
    point2_z = Column(Float, nullable=False)

    # Calculated distance between the two points
    distance = Column(Float, nullable=False)

    # Optional user-provided label/description
    label = Column(String, nullable=True)

    # Metadata (for future features like measurement types, units, etc.)
    metadata_json = Column(JSON, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationship
    pointcloud = relationship("PointCloud", backref="measurements")

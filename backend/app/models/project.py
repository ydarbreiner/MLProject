from sqlalchemy import Column, DateTime, Integer, String, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True)
    description = Column(String, nullable=True)
    geometry = Column(JSON, nullable=True)  # GeoJSON geometry describing the project footprint
    centroid = Column(JSON, nullable=True)  # { "lat": float, "lng": float }
    poles = Column(JSON, nullable=True)  # List of pole coordinates extracted from project files
    metadata_json = Column("metadata", JSON, nullable=True)  # Arbitrary metadata such as tags or owner info
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    pointclouds = relationship("PointCloud", back_populates="project")
    files = relationship("ProjectFile", back_populates="project", cascade="all, delete-orphan")

from sqlalchemy import Column, Integer, String, DateTime, BigInteger, JSON, Enum, ForeignKey, Float
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.core.database import Base
import enum

class ProcessingStatus(str, enum.Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"

class PointCloud(Base):
    __tablename__ = "pointclouds"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    original_filename = Column(String, nullable=False)
    file_size = Column(BigInteger, nullable=False)
    url = Column(String, nullable=True)  # URL to the processed COPC file
    status = Column(Enum(ProcessingStatus, name='processingstatus', values_callable=lambda x: [e.value for e in x]), default=ProcessingStatus.PENDING)

    # Metadata extracted from the point cloud
    point_count = Column(BigInteger, nullable=True)
    bounds = Column(JSON, nullable=True)  # Bounding box coordinates
    classification = Column(JSON, nullable=True)  # Classification statistics
    footprint = Column(JSON, nullable=True)  # GeoJSON footprint polygon in WGS84
    coverage_area_km2 = Column(Float, nullable=True)  # Coverage area in square kilometers
    coverage_area_sqft = Column(Float, nullable=True)  # Coverage area in square feet

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    processed_at = Column(DateTime(timezone=True), nullable=True)

    # Processing details
    error_message = Column(String, nullable=True)
    processing_log = Column(String, nullable=True)

    # Project linkage
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True)
    project = relationship("Project", back_populates="pointclouds")
    classification_edit_batches = relationship(
        "ClassificationEditBatch",
        back_populates="pointcloud",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

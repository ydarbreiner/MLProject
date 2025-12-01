import enum
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer, JSON, String, BigInteger
from sqlalchemy.orm import relationship

from app.core.database import Base


class ClassificationEditStatus(str, enum.Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class ClassificationEditBatch(Base):
    __tablename__ = "classification_edit_batches"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    pointcloud_id = Column(Integer, ForeignKey("pointclouds.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(
        Enum(
            ClassificationEditStatus,
            name="classificationeditstatus",
            values_callable=lambda x: [e.value for e in x],
            create_type=False,
        ),
        nullable=False,
        default=ClassificationEditStatus.QUEUED,
    )
    total_points = Column(BigInteger, nullable=False, default=0)
    unstable_count = Column(BigInteger, nullable=False, default=0)
    metadata_payload = Column("metadata", JSON, nullable=True)
    operations = Column(JSON, nullable=False, default=list)
    error_details = Column(JSON, nullable=True)
    tiles_total = Column(Integer, nullable=False, default=0)
    tiles_processed = Column(Integer, nullable=False, default=0)
    points_processed = Column(BigInteger, nullable=False, default=0)

    received_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    pointcloud = relationship(
        "PointCloud",
        back_populates="classification_edit_batches",
        passive_deletes=True,
    )

import enum
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import relationship

from app.core.database import Base


class ClusterJobStatus(str, enum.Enum):
    QUEUED = "queued"
    TRAINING = "training"
    EXTRACTING = "extracting"
    CLUSTERING = "clustering"
    BUILDING_OVERLAY = "building_overlay"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ClusterGenerationJob(Base):
    __tablename__ = "cluster_generation_jobs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    pointcloud_id = Column(Integer, ForeignKey("pointclouds.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(
        Enum(
            ClusterJobStatus,
            name="clusterjobstatus",
            values_callable=lambda x: [e.value for e in x],
            create_type=False,
        ),
        nullable=False,
        default=ClusterJobStatus.QUEUED,
    )

    # Job configuration
    run_name = Column(String, nullable=False)
    cluster_job_name = Column(String, nullable=True)
    num_clusters = Column(Integer, nullable=False, default=12)
    max_training_steps = Column(Integer, nullable=False, default=2000)
    patches_per_file = Column(Integer, nullable=False, default=2048)

    # Progress tracking
    current_step = Column(Integer, nullable=False, default=0)
    total_steps = Column(Integer, nullable=True)
    progress_message = Column(String, nullable=True)

    # Results
    overlay_path = Column(String, nullable=True)
    embedding_path = Column(String, nullable=True)
    checkpoint_path = Column(String, nullable=True)
    worker_task_id = Column(String, nullable=True)
    metrics = Column(JSON, nullable=True)
    error_details = Column(JSON, nullable=True)

    # Timestamps
    received_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    pointcloud = relationship(
        "PointCloud",
        backref="cluster_jobs",
        passive_deletes=True,
    )

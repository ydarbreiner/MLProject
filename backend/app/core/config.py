from pydantic_settings import BaseSettings
from typing import Optional
import os

class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql://postgres:password@postgres/pointcloud_viewer"

    # File Storage
    upload_dir: str = "uploads"
    pointcloud_output_dir: str = "pointclouds"
    max_file_size: int = 10 * 1024 * 1024 * 1024  # 10GB

    # Processing
    potree_converter_path: str = "/usr/local/bin/PotreeConverter"
    chunk_size: int = 5 * 1024 * 1024  # 5MB chunks
    keep_raw_uploads: bool = True  # Keep original LAS files for clustering pipeline

    # Celery / Queue
    redis_url: str = "redis://redis:6379/0"
    classification_queue: str = "classification-edits"
    classification_task_timeout: int = 60 * 60  # 1 hour default

    # CORS
    allowed_origins: list = ["http://localhost:4200", "http://127.0.0.1:4200"]

    # API
    api_prefix: str = "/api"

    class Config:
        env_file = ".env"

settings = Settings()

# Ensure directories exist
os.makedirs(settings.upload_dir, exist_ok=True)
os.makedirs(settings.pointcloud_output_dir, exist_ok=True)
os.makedirs(os.path.join(settings.upload_dir, "projects"), exist_ok=True)

from celery import Celery

from app.core.config import settings


celery_app = Celery(
    "pointcloud_viewer",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.services.classification_worker", "app.services.clustering_worker"],
)

celery_app.conf.update(
    task_default_queue=settings.classification_queue,
    task_track_started=True,
    task_time_limit=settings.classification_task_timeout,
)

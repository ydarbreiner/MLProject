from celery import shared_task

from app.core.config import settings
from app.services.classification_edits import process_classification_edit_batch


@shared_task(
    name="app.services.classification_worker.process_classification_edit_batch_task",
    bind=True,
    time_limit=settings.classification_task_timeout,
)
def process_classification_edit_batch_task(self, batch_id: str) -> None:
    process_classification_edit_batch(batch_id)

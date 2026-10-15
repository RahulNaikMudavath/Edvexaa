import os

from celery import Celery


redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
celery_app = Celery("flowforge", broker=redis_url)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_ignore_result=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_connection_retry_on_startup=True,
)

celery_app.autodiscover_tasks(["app"])

import json
import logging
from datetime import timedelta
from urllib.parse import urlparse

import httpx
from celery import Task
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from .celery_app import celery_app
from .database import SessionLocal
from .failure_analysis import (
    AnalysisProviderError,
    AnalysisUnavailableError,
    InvalidAnalysisResponse,
    build_rule_based_analysis,
    request_failure_analysis,
)
from .models import Execution, ExecutionAnalysis, ExecutionLog, utcnow


logger = logging.getLogger(__name__)
MAX_WORKFLOW_RETRIES = 10
MAX_BACKOFF_SECONDS = 300


class PermanentExecutionError(Exception):
    pass


class RetryableExecutionError(Exception):
    pass


def schedule_failure_analysis(execution_id: str) -> None:
    db = SessionLocal()
    try:
        execution = db.get(Execution, execution_id)
        if execution is None or execution.status != "Failed":
            return

        analysis = db.scalar(
            select(ExecutionAnalysis).where(
                ExecutionAnalysis.execution_id == execution_id
            )
        )
        if analysis is None:
            analysis = ExecutionAnalysis(execution_id=execution_id, status="Pending")
            db.add(analysis)
            db.commit()
        else:
            db.commit()

        if analysis.status != "Pending":
            return
        analyze_execution_failure.apply_async(
            args=[execution_id],
            task_id=f"analysis-{execution_id}",
        )
    except Exception:
        db.rollback()
        logger.exception(
            "Could not schedule failure analysis for execution %s",
            execution_id,
        )
        try:
            analysis = db.scalar(
                select(ExecutionAnalysis).where(
                    ExecutionAnalysis.execution_id == execution_id
                )
            )
            if analysis is not None and analysis.status == "Pending":
                analysis.status = "Failed"
                analysis.error_message = "Failure analysis could not be queued."
                analysis.completed_at = utcnow()
                db.commit()
        except Exception:
            db.rollback()
            logger.exception(
                "Could not persist analysis queue failure for execution %s",
                execution_id,
            )
    finally:
        db.close()


def retry_backoff_seconds(retry_number: int) -> int:
    return min(2 ** (retry_number + 1), MAX_BACKOFF_SECONDS)


def execute_action(
    action: dict,
    event_payload: dict | None = None,
) -> str:
    action_type = action.get("type")
    config = action.get("config") or {}

    if not isinstance(config, dict):
        raise PermanentExecutionError("Action config must be an object")

    if action_type == "log":
        message = config.get("message", "Log action executed")
        if not isinstance(message, str):
            raise PermanentExecutionError(
                "The log action message must be a string"
            )
        logger.info("Workflow action: %s", message)
        return message

    if action_type == "transform":
        payload = event_payload or {}
        fields = config.get("fields", {})

        if not isinstance(fields, dict):
            raise PermanentExecutionError(
                "Transform config 'fields' must be an object"
            )

        transformed = {}
        for target, source in fields.items():
            if not isinstance(target, str) or not isinstance(source, str):
                raise PermanentExecutionError(
                    "Transform field names and source paths must be strings"
                )

            value = payload
            for part in source.split("."):
                if not isinstance(value, dict) or part not in value:
                    value = None
                    break
                value = value[part]

            transformed[target] = value

        return "Transform completed: " + json.dumps(
            transformed, ensure_ascii=True, default=str
        )

    if action_type == "notification":
        message = config.get("message")
        recipient = config.get("recipient", "demo")

        if not isinstance(message, str) or not message.strip():
            raise PermanentExecutionError(
                "Notification config requires a non-empty message"
            )

        if not isinstance(recipient, str) or not recipient.strip():
            raise PermanentExecutionError(
                "Notification recipient must be a non-empty string"
            )

        logger.info(
            "Simulated notification to %s",
            recipient,
        )
        return "Simulated notification: " + message

    if action_type == "http_request":
        url = config.get("url")
        method = config.get("method", "POST")
        headers = config.get("headers", {})
        body = config.get("body", event_payload or {})

        if not isinstance(url, str):
            raise PermanentExecutionError(
                "HTTP action requires a URL"
            )

        parsed = urlparse(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise PermanentExecutionError(
                "HTTP action URL must be a valid HTTP(S) URL"
            )

        if not isinstance(method, str) or method.upper() not in {
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
        }:
            raise PermanentExecutionError(
                "Unsupported HTTP method"
            )

        if not isinstance(headers, dict) or not all(
            isinstance(k, str) and isinstance(v, str)
            for k, v in headers.items()
        ):
            raise PermanentExecutionError(
                "HTTP headers must be a string-to-string object"
            )

        try:
            with httpx.Client(
                timeout=10.0,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = client.request(
                    method.upper(),
                    url,
                    headers=headers,
                    json=body,
                )

            if response.status_code == 429 or response.status_code >= 500:
                raise RetryableExecutionError(
                    f"HTTP request returned status {response.status_code}"
                )

            if response.is_error:
                raise PermanentExecutionError(
                    f"HTTP request returned status {response.status_code}"
                )

            return (
                f"HTTP {method.upper()} succeeded "
                f"with status {response.status_code}"
            )

        except httpx.TimeoutException as exc:
            raise RetryableExecutionError(
                "HTTP request timed out"
            ) from exc
        except httpx.RequestError as exc:
            raise RetryableExecutionError(
                f"HTTP request failed: {type(exc).__name__}"
            ) from exc

    raise PermanentExecutionError(
        f"Unsupported workflow action: {action_type}"
    )


@celery_app.task(
    bind=True,
    name="flowforge.execute_workflow",
    max_retries=MAX_WORKFLOW_RETRIES,
)
def execute_workflow(self: Task, execution_id: str) -> dict:
    db = SessionLocal()
    try:
        now = utcnow()
        claimed = db.execute(
            update(Execution)
            .where(
                Execution.id == execution_id,
                Execution.status == "Pending",
                or_(
                    Execution.next_attempt_at.is_(None),
                    Execution.next_attempt_at <= now,
                ),
            )
            .values(
                status="Running",
                attempt_count=Execution.attempt_count + 1,
                started_at=now,
                next_attempt_at=None,
            )
            .execution_options(synchronize_session=False)
        )
        db.commit()
        if claimed.rowcount != 1:
            return {"execution_id": execution_id, "status": "Skipped"}

        execution = db.get(Execution, execution_id)
        if execution is None:
            return {"execution_id": execution_id, "status": "Skipped"}
        actions = execution.workflow.actions
        retry_number = self.request.retries
        max_retries = max(
            0,
            min(execution.workflow.max_retries, MAX_WORKFLOW_RETRIES),
        )
        db.add(
            ExecutionLog(
                execution_id=execution_id,
                level="INFO",
                message=f"Attempt {execution.attempt_count} started",
            )
        )
        db.commit()

        try:
            for action in actions:
                message = execute_action(action, execution.event.payload)
                db.add(
                    ExecutionLog(
                        execution_id=execution_id,
                        level="INFO",
                        message=message,
                    )
                )
                db.commit()
        except Exception as exc:
            is_permanent = isinstance(exc, PermanentExecutionError)
            will_retry = not is_permanent and retry_number < max_retries
            countdown = retry_backoff_seconds(retry_number)
            execution.status = "Pending" if will_retry else "Failed"
            execution.next_attempt_at = (
                utcnow() + timedelta(seconds=countdown) if will_retry else None
            )
            execution.completed_at = None if will_retry else utcnow()
            db.add(
                ExecutionLog(
                    execution_id=execution_id,
                    level="ERROR",
                    message=f"{type(exc).__name__}: {exc}",
                )
            )
            db.commit()
            if will_retry:
                raise self.retry(
                    exc=exc,
                    countdown=countdown,
                    max_retries=max_retries,
                )
            schedule_failure_analysis(execution_id)
            return {"execution_id": execution_id, "status": "Failed"}

        execution.status = "Completed"
        execution.completed_at = utcnow()
        execution.next_attempt_at = None
        db.add(
            ExecutionLog(
                execution_id=execution_id,
                level="INFO",
                message="Execution completed",
            )
        )
        db.commit()
        return {"execution_id": execution_id, "status": "Completed"}
    finally:
        db.close()


@celery_app.task(name="flowforge.analyze_execution_failure")
def analyze_execution_failure(execution_id: str) -> dict:
    db = SessionLocal()
    try:
        execution = db.get(Execution, execution_id)
        if execution is None or execution.status != "Failed":
            return {"execution_id": execution_id, "analysis_status": "Skipped"}

        analysis = db.scalar(
            select(ExecutionAnalysis).where(
                ExecutionAnalysis.execution_id == execution_id
            )
        )
        if analysis is None:
            try:
                with db.begin_nested():
                    db.add(ExecutionAnalysis(execution_id=execution_id, status="Pending"))
                    db.flush()
                db.commit()
            except IntegrityError:
                db.rollback()

        now = utcnow()
        claimed = db.execute(
            update(ExecutionAnalysis)
            .where(
                ExecutionAnalysis.execution_id == execution_id,
                ExecutionAnalysis.status == "Pending",
            )
            .values(status="Running")
            .execution_options(synchronize_session=False)
        )
        db.commit()
        if claimed.rowcount != 1:
            return {"execution_id": execution_id, "analysis_status": "Skipped"}

        analysis = db.scalar(
            select(ExecutionAnalysis).where(
                ExecutionAnalysis.execution_id == execution_id
            )
        )
        if analysis is None or execution is None or execution.status != "Failed":
            if analysis is not None:
                analysis.status = "Failed"
                analysis.error_message = "Failure analysis requires a failed execution."
                analysis.completed_at = now
                db.commit()
            return {"execution_id": execution_id, "analysis_status": "Failed"}

        context = {
            "execution_id": execution.id,
            "workflow": {
                "id": execution.workflow.id,
                "name": execution.workflow.name,
                "event_type": execution.workflow.event_type,
                "actions": execution.workflow.actions,
            },
            "event": {
                "id": execution.event.id,
                "external_event_id": execution.event.external_event_id,
                "event_type": execution.event.event_type,
                "payload": execution.event.payload,
            },
            "attempt_count": execution.attempt_count,
            "max_retries": execution.workflow.max_retries,
            "error_message": next(
                (
                    entry.message
                    for entry in reversed(execution.logs)
                    if entry.level == "ERROR"
                ),
                "Workflow execution failed.",
            ),
            "logs": [
                {
                    "level": entry.level,
                    "message": entry.message,
                    "created_at": entry.created_at.isoformat(),
                }
                for entry in execution.logs
            ],
        }

        try:
            result = request_failure_analysis(context)
            analysis.status = "Completed"
            analysis.error_message = None
        except (
            AnalysisUnavailableError,
            AnalysisProviderError,
            InvalidAnalysisResponse,
        ) as exc:
            result = build_rule_based_analysis(context, str(exc))
            analysis.status = "Completed"
            analysis.error_message = f"Rule-based fallback used: {exc}"
        except Exception:
            logger.exception(
                "Unexpected failure-analysis error for execution %s",
                execution_id,
            )
            result = build_rule_based_analysis(
                context,
                "Unexpected analysis error.",
            )
            analysis.status = "Completed"
            analysis.error_message = (
                "Rule-based fallback used after an unexpected analysis error."
            )

        analysis.summary = result["summary"]
        analysis.likely_cause = result["likely_cause"]
        analysis.suggested_remediation = result["suggested_remediation"]
        analysis.confidence = result["confidence"]
        analysis.completed_at = utcnow()
        db.commit()

        return {
            "execution_id": execution_id,
            "analysis_status": analysis.status,
            "analysis_source": result.get("analysis_source", "ai"),
        }
    finally:
        db.close()

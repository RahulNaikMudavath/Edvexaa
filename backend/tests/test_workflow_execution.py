import hashlib
import hmac
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import failure_analysis, main, tasks
from app.celery_app import celery_app
from app.database import Base, get_db
from app.failure_analysis import (
    AnalysisProviderError,
    InvalidAnalysisResponse,
    request_failure_analysis,
    validate_analysis_response,
)
from app.models import (
    Execution,
    ExecutionAnalysis,
    ExecutionLog,
    Integration,
    WebhookEvent,
    Workflow,
)


@pytest.fixture
def session_factory(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    monkeypatch.setattr(tasks, "SessionLocal", factory)
    yield factory
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture
def client(session_factory, monkeypatch):
    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    main.app.dependency_overrides[get_db] = override_get_db
    queued = []
    monkeypatch.setattr(
        main.execute_workflow,
        "apply_async",
        lambda args, task_id=None: queued.append((args[0], task_id)),
    )
    test_client = TestClient(main.app)
    test_client.queued_executions = queued
    test_client.session_factory = session_factory
    yield test_client
    main.app.dependency_overrides.clear()


def create_execution(session_factory, actions=None, max_retries=2):
    with session_factory() as db:
        integration = Integration(
            id="integration-1",
            name="Test integration",
            webhook_secret="test-secret",
            event_types=["order.created"],
        )
        workflow = Workflow(
            id="workflow-1",
            name="Test workflow",
            integration_id=integration.id,
            event_type="order.created",
            actions=actions if actions is not None else [{"type": "log", "config": {"message": "hello"}}],
            max_retries=max_retries,
        )
        event = WebhookEvent(
            id="event-1",
            integration_id=integration.id,
            external_event_id="external-1",
            event_type="order.created",
            payload={"event_id": "external-1", "event_type": "order.created"},
        )
        db.add_all([integration, workflow, event])
        db.flush()
        execution = Execution(workflow_id=workflow.id, event_id=event.id)
        db.add(execution)
        db.commit()
        return execution.id


def make_signed_webhook(client, external_event_id):
    with client.session_factory() as db:
        integration = db.get(Integration, "integration-1")
        secret = integration.webhook_secret
        integration_id = integration.id
    body = json.dumps(
        {"event_id": external_event_id, "event_type": "order.created"},
        separators=(",", ":"),
    ).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return client.post(
        f"/api/webhooks/{integration_id}",
        content=body,
        headers={"Content-Type": "application/json", "X-FlowForge-Signature": f"sha256={signature}"},
    )


def test_successful_log_action_records_execution_and_logs(session_factory):
    execution_id = create_execution(session_factory)

    result = tasks.execute_workflow.apply(args=[execution_id], throw=True)

    assert result.get()["status"] == "Completed"
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        assert execution.status == "Completed"
        assert execution.attempt_count == 1
        assert [entry.message for entry in execution.logs] == [
            "Attempt 1 started",
            "hello",
            "Execution completed",
        ]
        assert execution.failure_analysis is None


def test_permanent_action_failure_marks_execution_failed(session_factory, monkeypatch):
    monkeypatch.setattr(tasks, "schedule_failure_analysis", lambda execution_id: None)
    execution_id = create_execution(
        session_factory,
        actions=[{"type": "unknown", "config": {}}],
    )

    result = tasks.execute_workflow.apply(args=[execution_id], throw=True)

    assert result.get()["status"] == "Failed"
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        assert execution.status == "Failed"
        assert execution.attempt_count == 1
        assert any("Unsupported workflow action" in entry.message for entry in execution.logs)
        assert db.scalar(select(func.count(ExecutionAnalysis.id))) == 0


def test_retry_backoff_is_exponential_and_capped():
    assert [tasks.retry_backoff_seconds(index) for index in range(3)] == [2, 4, 8]
    assert tasks.retry_backoff_seconds(20) == tasks.MAX_BACKOFF_SECONDS


def test_retryable_failure_retries_then_completes(session_factory, monkeypatch):
    execution_id = create_execution(session_factory, max_retries=2)
    original_execute_action = tasks.execute_action
    calls = 0

    def fail_once(action):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise tasks.RetryableExecutionError("temporary failure")
        return original_execute_action(action)

    monkeypatch.setattr(tasks, "execute_action", fail_once)
    monkeypatch.setattr(tasks, "retry_backoff_seconds", lambda retry_number: 0)
    monkeypatch.setattr(celery_app.conf, "task_always_eager", True)
    monkeypatch.setattr(celery_app.conf, "task_eager_propagates", False)

    result = tasks.execute_workflow.apply_async(args=[execution_id])

    assert result.get()["status"] == "Completed"
    assert calls == 2
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        assert execution.status == "Completed"
        assert execution.attempt_count == 2
        assert sum(entry.level == "ERROR" for entry in execution.logs) == 1


def test_retryable_failure_stops_at_configured_retry_limit(session_factory, monkeypatch):
    execution_id = create_execution(session_factory, max_retries=1)
    scheduled = []
    monkeypatch.setattr(tasks, "schedule_failure_analysis", scheduled.append)

    def always_fail(action):
        raise tasks.RetryableExecutionError("still unavailable")

    monkeypatch.setattr(tasks, "execute_action", always_fail)
    monkeypatch.setattr(tasks, "retry_backoff_seconds", lambda retry_number: 0)
    monkeypatch.setattr(celery_app.conf, "task_always_eager", True)
    monkeypatch.setattr(celery_app.conf, "task_eager_propagates", False)

    result = tasks.execute_workflow.apply_async(args=[execution_id])

    assert result.get()["status"] == "Failed"
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        assert execution.status == "Failed"
        assert execution.attempt_count == 2
        assert sum(entry.level == "ERROR" for entry in execution.logs) == 2
    assert scheduled == [execution_id]


def test_duplicate_webhook_creates_one_execution_and_worker_claim_is_idempotent(
    session_factory, client
):
    with session_factory() as db:
        db.add(
            Integration(
                id="integration-1",
                name="Test integration",
                webhook_secret="test-secret",
                event_types=["order.created"],
            )
        )
        db.add(
            Workflow(
                id="workflow-1",
                name="Test workflow",
                integration_id="integration-1",
                event_type="order.created",
                actions=[{"type": "log", "config": {"message": "once"}}],
            )
        )
        db.commit()
    first = make_signed_webhook(client, "external-1")
    duplicate = make_signed_webhook(client, "external-1")

    assert first.status_code == 202
    assert first.json()["duplicate"] is False
    assert duplicate.status_code == 202
    assert duplicate.json()["duplicate"] is True
    assert len(client.queued_executions) == 2
    execution_id = client.queued_executions[0][0]
    with session_factory() as db:
        assert db.scalar(select(func.count(Execution.id))) == 1

    first_run = tasks.execute_workflow.apply(args=[execution_id], throw=True)
    second_run = tasks.execute_workflow.apply(args=[execution_id], throw=True)

    assert first_run.get()["status"] == "Completed"
    assert second_run.get()["status"] == "Skipped"
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        assert execution.attempt_count == 1
        assert db.scalar(select(func.count(ExecutionLog.id))) == 3


def test_execution_api_lists_detail_and_logs(session_factory, client):
    execution_id = create_execution(session_factory)
    tasks.execute_workflow.apply(args=[execution_id], throw=True)

    listed = client.get("/api/executions")
    detail = client.get(f"/api/executions/{execution_id}")

    assert listed.status_code == 200
    assert listed.json()[0]["status"] == "Completed"
    assert listed.json()[0]["workflow_name"] == "Test workflow"
    assert listed.json()[0]["event_type"] == "order.created"
    assert listed.json()[0]["max_retries"] == 2
    assert detail.status_code == 200
    assert detail.json()["id"] == execution_id
    assert detail.json()["workflow_name"] == "Test workflow"
    assert detail.json()["event_type"] == "order.created"
    assert detail.json()["max_retries"] == 2
    assert [entry["message"] for entry in detail.json()["logs"]][-1] == "Execution completed"
    assert detail.json()["failure_analysis"] is None


def mark_execution_failed(session_factory, execution_id):
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        execution.status = "Failed"
        execution.completed_at = execution.created_at
        db.add(
            ExecutionLog(
                execution_id=execution_id,
                level="ERROR",
                message="PermanentExecutionError: unsupported action",
            )
        )
        db.commit()


def analysis_task_result(execution_id):
    return tasks.analyze_execution_failure.apply(args=[execution_id], throw=True).get()


def test_failure_analysis_is_persisted_and_duplicate_delivery_does_not_call_provider(
    session_factory, monkeypatch, client
):
    execution_id = create_execution(session_factory)
    mark_execution_failed(session_factory, execution_id)
    expected = {
        "summary": "A configured action is unsupported.",
        "likely_cause": "The workflow has an action type the worker does not implement.",
        "suggested_remediation": "Replace it with a supported log action.",
        "confidence": 0.91,
    }
    captured = []

    def fake_provider(context):
        captured.append(context)
        return expected

    monkeypatch.setattr(tasks, "request_failure_analysis", fake_provider)

    assert analysis_task_result(execution_id)["analysis_status"] == "Completed"
    assert analysis_task_result(execution_id)["analysis_status"] == "Skipped"
    assert len(captured) == 1
    assert captured[0]["error_message"] == "PermanentExecutionError: unsupported action"
    assert captured[0]["workflow"]["name"] == "Test workflow"
    assert captured[0]["event"]["event_type"] == "order.created"
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        analysis = execution.failure_analysis
        assert analysis.status == "Completed"
        assert analysis.summary == expected["summary"]
        assert analysis.likely_cause == expected["likely_cause"]
        assert analysis.suggested_remediation == expected["suggested_remediation"]
        assert analysis.confidence == 0.91
        assert execution.status == "Failed"
        assert execution.attempt_count == 0
        assert [entry.message for entry in execution.logs] == [
            "PermanentExecutionError: unsupported action"
        ]
        assert db.scalar(select(func.count(ExecutionAnalysis.id))) == 1
    detail = client.get(f"/api/executions/{execution_id}")
    assert detail.status_code == 200
    assert detail.json()["failure_analysis"]["status"] == "Completed"
    assert detail.json()["failure_analysis"]["summary"] == expected["summary"]


def test_invalid_analysis_output_is_persisted_as_failed(session_factory, monkeypatch):
    execution_id = create_execution(session_factory)
    mark_execution_failed(session_factory, execution_id)

    def invalid_provider(context):
        return validate_analysis_response('{"confidence": 1.4}')

    monkeypatch.setattr(tasks, "request_failure_analysis", invalid_provider)

    result = analysis_task_result(execution_id)

    assert result["analysis_status"] == "Failed"
    with session_factory() as db:
        analysis = db.scalar(select(ExecutionAnalysis))
        assert analysis.status == "Failed"
        assert "exactly the required fields" in analysis.error_message
        assert analysis.confidence is None
        assert db.get(Execution, execution_id).status == "Failed"


def test_provider_error_is_persisted_without_touching_execution(session_factory, monkeypatch):
    execution_id = create_execution(session_factory)
    mark_execution_failed(session_factory, execution_id)
    monkeypatch.setattr(
        tasks,
        "request_failure_analysis",
        lambda context: (_ for _ in ()).throw(AnalysisProviderError("Provider unavailable.")),
    )

    assert analysis_task_result(execution_id)["analysis_status"] == "Failed"
    with session_factory() as db:
        execution = db.get(Execution, execution_id)
        analysis = execution.failure_analysis
        assert analysis.error_message == "Provider unavailable."
        assert execution.status == "Failed"
        assert execution.attempt_count == 0
        assert [entry.message for entry in execution.logs] == [
            "PermanentExecutionError: unsupported action"
        ]


def test_missing_provider_configuration_marks_analysis_unavailable(
    session_factory, monkeypatch
):
    execution_id = create_execution(session_factory)
    mark_execution_failed(session_factory, execution_id)
    for name in ("LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(tasks, "request_failure_analysis", request_failure_analysis)

    assert analysis_task_result(execution_id)["analysis_status"] == "Unavailable"
    with session_factory() as db:
        analysis = db.scalar(select(ExecutionAnalysis))
        assert analysis.status == "Unavailable"
        assert "LLM_API_KEY" in analysis.error_message
        assert analysis.summary is None


def test_analysis_output_validation_requires_complete_fields_and_bounded_confidence():
    valid = (
        '{"summary":"s","likely_cause":"c",'
        '"suggested_remediation":"r","confidence":0.5}'
    )
    assert validate_analysis_response(valid)["confidence"] == 0.5
    for content in (
        "not JSON",
        '{"summary":"s","likely_cause":"c","suggested_remediation":"r","confidence":true}',
        '{"summary":"s","likely_cause":"c","suggested_remediation":"r","confidence":-0.1}',
        '{"summary":" ","likely_cause":"c","suggested_remediation":"r","confidence":0.5}',
    ):
        with pytest.raises(InvalidAnalysisResponse):
            validate_analysis_response(content)



def test_provider_http_call_is_mocked_and_uses_bounded_timeout(monkeypatch):
    for name, value in {
        "LLM_API_KEY": "test-only-key",
        "LLM_MODEL": "gemini-3.5-flash-lite",
        "LLM_BASE_URL": (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            "gemini-3.5-flash-lite:generateContent"
        ),
        "LLM_TIMEOUT_SECONDS": "500",
    }.items():
        monkeypatch.setenv(name, value)

    calls = []
    content = (
        '{"summary":"s","likely_cause":"c",'
        '"suggested_remediation":"r","confidence":0.75}'
    )

    class MockResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "candidates": [
                    {
                        "content": {
                            "parts": [{"text": content}]
                        }
                    }
                ]
            }

    def mock_post(*args, **kwargs):
        calls.append((args, kwargs))
        return MockResponse()

    monkeypatch.setattr(failure_analysis.httpx, "post", mock_post)

    result = request_failure_analysis({"event": "test"})

    assert result["confidence"] == 0.75
    assert calls[0][0][0] == (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-3.5-flash-lite:generateContent"
)
    assert calls[0][1]["headers"]["x-goog-api-key"] == "test-only-key"
    assert calls[0][1]["timeout"].read == 30
    assert calls[0][1]["json"]["contents"][0]["parts"][0]["text"]

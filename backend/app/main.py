import hashlib
import hmac
import json
import logging
import os
import secrets
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from .database import Base, engine, get_db
from .models import Execution, Integration, WebhookEvent, Workflow, utcnow
from .schemas import IntegrationCreate, WorkflowCreate
from .tasks import execute_workflow


logger = logging.getLogger(__name__)

app = FastAPI(
    title="FlowForge AI API",
    description="Webhook-driven workflow automation platform",
    version="0.1.0",
)

frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[frontend_origin, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Convenient for the assignment starter. Use Alembic migrations in production.
@app.on_event("startup")
def create_tables():
    Base.metadata.create_all(bind=engine)


@app.get("/health")
def health():
    return {"status": "ok", "service": "flowforge-api"}


@app.get("/api/integrations")
def list_integrations(db: Session = Depends(get_db)):
    rows = db.scalars(select(Integration).order_by(Integration.created_at.desc())).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "provider": row.provider,
            "event_types": row.event_types,
            "is_active": row.is_active,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@app.post("/api/integrations", status_code=201)
def create_integration(body: IntegrationCreate, db: Session = Depends(get_db)):
    integration = Integration(
        name=body.name,
        provider=body.provider,
        event_types=body.event_types,
        webhook_secret=secrets.token_hex(32),
    )
    db.add(integration)
    db.commit()
    db.refresh(integration)
    # Return the secret once for local development/testing. Never expose it on list endpoints.
    return {
        "id": integration.id,
        "name": integration.name,
        "provider": integration.provider,
        "event_types": integration.event_types,
        "is_active": integration.is_active,
        "webhook_secret": integration.webhook_secret,
        "webhook_url": f"/api/webhooks/{integration.id}",
    }


@app.get("/api/workflows")
def list_workflows(db: Session = Depends(get_db)):
    rows = db.scalars(select(Workflow).order_by(Workflow.created_at.desc())).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "integration_id": row.integration_id,
            "event_type": row.event_type,
            "actions": row.actions,
            "max_retries": row.max_retries,
            "is_active": row.is_active,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]


@app.post("/api/workflows", status_code=201)
def create_workflow(body: WorkflowCreate, db: Session = Depends(get_db)):
    integration = db.get(Integration, body.integration_id)
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")
    if body.event_type not in integration.event_types:
        raise HTTPException(
            status_code=400,
            detail="Workflow event_type must be registered on the integration",
        )
    workflow = Workflow(
        name=body.name,
        integration_id=body.integration_id,
        event_type=body.event_type,
        actions=[action.model_dump() for action in body.actions],
        max_retries=body.max_retries,
    )
    db.add(workflow)
    db.commit()
    db.refresh(workflow)
    return {
        "id": workflow.id,
        "name": workflow.name,
        "integration_id": workflow.integration_id,
        "event_type": workflow.event_type,
        "actions": workflow.actions,
        "max_retries": workflow.max_retries,
        "is_active": workflow.is_active,
    }


@app.get("/api/events")
def list_events(limit: int = 50, db: Session = Depends(get_db)):
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    rows = db.scalars(
        select(WebhookEvent).order_by(WebhookEvent.received_at.desc()).limit(limit)
    ).all()
    return [
        {
            "id": row.id,
            "integration_id": row.integration_id,
            "external_event_id": row.external_event_id,
            "event_type": row.event_type,
            "payload": row.payload,
            "received_at": row.received_at.isoformat(),
        }
        for row in rows
    ]


def execution_dict(execution: Execution, include_logs: bool = False):
    result = {
        "id": execution.id,
        "workflow_id": execution.workflow_id,
        "workflow_name": execution.workflow.name,
        "event_id": execution.event_id,
        "event_type": execution.event.event_type,
        "status": execution.status,
        "attempt_count": execution.attempt_count,
        "max_retries": execution.workflow.max_retries,
        "created_at": execution.created_at.isoformat(),
        "started_at": execution.started_at.isoformat() if execution.started_at else None,
        "completed_at": execution.completed_at.isoformat() if execution.completed_at else None,
        "next_attempt_at": execution.next_attempt_at.isoformat() if execution.next_attempt_at else None,
    }
    if include_logs:
        result["logs"] = [
            {
                "id": entry.id,
                "level": entry.level,
                "message": entry.message,
                "created_at": entry.created_at.isoformat(),
            }
            for entry in execution.logs
        ]
        analysis = execution.failure_analysis
        result["failure_analysis"] = (
            {
                "status": analysis.status,
                "summary": analysis.summary,
                "analysis_source": (
                    "rule_based"
                    if (analysis.error_message or "").startswith("Rule-based fallback used")
                    else "ai"
                    if analysis.status == "Completed"
                    else None
                ),
                "likely_cause": analysis.likely_cause,
                "suggested_remediation": analysis.suggested_remediation,
                "confidence": analysis.confidence,
                "error_message": analysis.error_message,
                "created_at": analysis.created_at.isoformat(),
                "completed_at": analysis.completed_at.isoformat()
                if analysis.completed_at
                else None,
            }
            if analysis
            else None
        )
    return result


@app.get("/api/executions")
def list_executions(limit: int = 50, db: Session = Depends(get_db)):
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    rows = db.scalars(
        select(Execution)
        .options(joinedload(Execution.workflow), joinedload(Execution.event))
        .order_by(Execution.created_at.desc())
        .limit(limit)
    ).all()
    return [execution_dict(row) for row in rows]


@app.get("/api/executions/{execution_id}")
def get_execution(execution_id: str, db: Session = Depends(get_db)):
    execution = db.scalar(
        select(Execution)
        .options(
            joinedload(Execution.workflow),
            joinedload(Execution.event),
            joinedload(Execution.failure_analysis),
        )
        .where(Execution.id == execution_id)
    )
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    return execution_dict(execution, include_logs=True)


def enqueue_matching_workflows(event: WebhookEvent, db: Session) -> int:
    workflows = db.scalars(
        select(Workflow).where(
            Workflow.integration_id == event.integration_id,
            Workflow.event_type == event.event_type,
            Workflow.is_active.is_(True),
        )
    ).all()
    for workflow in workflows:
        execution = db.scalar(
            select(Execution).where(
                Execution.workflow_id == workflow.id,
                Execution.event_id == event.id,
            )
        )
        if execution is None:
            try:
                with db.begin_nested():
                    db.add(Execution(workflow_id=workflow.id, event_id=event.id))
                    db.flush()
            except IntegrityError:
                # Another delivery may have created this workflow/event execution.
                pass

    db.commit()
    ready_execution_ids = db.scalars(
        select(Execution.id).where(
            Execution.event_id == event.id,
            Execution.status == "Pending",
            or_(Execution.next_attempt_at.is_(None), Execution.next_attempt_at <= utcnow()),
        )
    ).all()
    try:
        for execution_id in ready_execution_ids:
            execute_workflow.apply_async(args=[execution_id], task_id=execution_id)
    except Exception as exc:
        logger.exception("Could not enqueue workflow execution for event %s", event.id)
        raise HTTPException(
            status_code=503,
            detail="Webhook event was persisted but workflow execution could not be queued",
        ) from exc
    return len(ready_execution_ids)


@app.post("/api/webhooks/{integration_id}", status_code=202)
async def receive_webhook(
    integration_id: str,
    request: Request,
    x_flowforge_signature: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    integration = db.get(Integration, integration_id)
    if not integration or not integration.is_active:
        raise HTTPException(status_code=404, detail="Active integration not found")

    raw_body = await request.body()
    expected = hmac.new(
        integration.webhook_secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    supplied = (x_flowforge_signature or "").removeprefix("sha256=")
    if not supplied or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Body must be valid JSON")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Webhook body must be a JSON object")

    external_event_id = payload.get("event_id")
    event_type = payload.get("event_type")
    if not isinstance(external_event_id, str) or not external_event_id.strip():
        raise HTTPException(status_code=400, detail="event_id is required")
    if not isinstance(event_type, str) or not event_type.strip():
        raise HTTPException(status_code=400, detail="event_type is required")
    if integration.event_types and event_type not in integration.event_types:
        raise HTTPException(status_code=400, detail="Unsupported event_type")

    existing = db.scalar(
        select(WebhookEvent).where(
            WebhookEvent.integration_id == integration_id,
            WebhookEvent.external_event_id == external_event_id,
        )
    )
    duplicate = existing is not None
    if existing:
        event = existing
    else:
        event = WebhookEvent(
            integration_id=integration_id,
            external_event_id=external_event_id,
            event_type=event_type,
            payload=payload,
        )
        db.add(event)
        try:
            db.commit()
        except IntegrityError:
            # Covers concurrent duplicate deliveries racing past the initial lookup.
            db.rollback()
            existing = db.scalar(
                select(WebhookEvent).where(
                    WebhookEvent.integration_id == integration_id,
                    WebhookEvent.external_event_id == external_event_id,
                )
            )
            if existing:
                event = existing
                duplicate = True
            else:
                raise HTTPException(status_code=409, detail="Could not persist event")
        else:
            db.refresh(event)

    enqueue_matching_workflows(event, db)
    return {
        "accepted": True,
        "duplicate": duplicate,
        "event_id": event.id,
        "message": "Duplicate event ignored; pending executions checked"
        if duplicate
        else "Webhook validated, persisted, and matching workflows queued",
    }

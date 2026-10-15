import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


def utcnow():
    return datetime.now(timezone.utc)


class Integration(Base):
    __tablename__ = "integrations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    provider: Mapped[str] = mapped_column(String(80), default="simulated", nullable=False)
    event_types: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    webhook_secret: Mapped[str] = mapped_column(String(128), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    integration_id: Mapped[str] = mapped_column(ForeignKey("integrations.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False)
    actions: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    max_retries: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    executions: Mapped[list["Execution"]] = relationship(back_populates="workflow")


class WebhookEvent(Base):
    __tablename__ = "webhook_events"
    __table_args__ = (
        UniqueConstraint("integration_id", "external_event_id", name="uq_integration_external_event"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    integration_id: Mapped[str] = mapped_column(ForeignKey("integrations.id"), nullable=False)
    external_event_id: Mapped[str] = mapped_column(String(200), nullable=False)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    executions: Mapped[list["Execution"]] = relationship(back_populates="event")


class Execution(Base):
    __tablename__ = "executions"
    __table_args__ = (
        UniqueConstraint("workflow_id", "event_id", name="uq_execution_workflow_event"),
        CheckConstraint(
            "status IN ('Pending', 'Running', 'Completed', 'Failed')",
            name="ck_execution_status",
        ),
        CheckConstraint("attempt_count >= 0", name="ck_execution_attempt_count"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id"), nullable=False)
    event_id: Mapped[str] = mapped_column(ForeignKey("webhook_events.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="Pending", nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    workflow: Mapped[Workflow] = relationship(back_populates="executions")
    event: Mapped[WebhookEvent] = relationship(back_populates="executions")
    logs: Mapped[list["ExecutionLog"]] = relationship(
        back_populates="execution",
        cascade="all, delete-orphan",
        order_by="ExecutionLog.created_at",
    )
    failure_analysis: Mapped["ExecutionAnalysis | None"] = relationship(
        back_populates="execution",
        cascade="all, delete-orphan",
        uselist=False,
    )


class ExecutionLog(Base):
    __tablename__ = "execution_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    execution_id: Mapped[str] = mapped_column(
        ForeignKey("executions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    level: Mapped[str] = mapped_column(String(20), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    execution: Mapped[Execution] = relationship(back_populates="logs")


class ExecutionAnalysis(Base):
    __tablename__ = "execution_analyses"
    __table_args__ = (
        UniqueConstraint("execution_id", name="uq_execution_analysis_execution"),
        CheckConstraint(
            "status IN ('Pending', 'Running', 'Completed', 'Failed', 'Unavailable')",
            name="ck_execution_analysis_status",
        ),
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_execution_analysis_confidence",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    execution_id: Mapped[str] = mapped_column(
        ForeignKey("executions.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), default="Pending", nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    likely_cause: Mapped[str | None] = mapped_column(Text)
    suggested_remediation: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    execution: Mapped[Execution] = relationship(back_populates="failure_analysis")

from pydantic import BaseModel, Field, ConfigDict


class IntegrationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    provider: str = Field(default="simulated", max_length=80)
    event_types: list[str] = Field(default_factory=list)


class IntegrationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    provider: str
    event_types: list[str]
    is_active: bool
    created_at: str | None = None
    webhook_secret: str | None = None


class ActionConfig(BaseModel):
    type: str = Field(description="For this milestone, use log or transform")
    config: dict = Field(default_factory=dict)


class WorkflowCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    integration_id: str
    event_type: str
    actions: list[ActionConfig] = Field(default_factory=list)
    max_retries: int = Field(default=3, ge=0, le=10)


class WorkflowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    integration_id: str
    event_type: str
    actions: list
    max_retries: int
    is_active: bool


class WebhookAccepted(BaseModel):
    accepted: bool
    duplicate: bool
    event_id: str
    message: str

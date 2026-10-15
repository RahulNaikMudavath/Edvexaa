# FlowForge AI

A workflow automation platform for the Edvexa Software Engineering Internship assignment.

## Current starter milestone
- FastAPI REST API
- PostgreSQL persistence via SQLAlchemy
- Integration registration and generated webhook secrets
- Workflow configuration storage
- HMAC-SHA256 webhook verification
- Duplicate event detection using a per-integration event ID
- React + Tailwind dashboard starter
- Docker Compose development environment

## Run locally
Prerequisites: Docker Desktop and Git.

```bash
docker compose up --build
```

Then open:
- Frontend: http://localhost:5173
- API docs: http://localhost:8001/docs
- Health check: http://localhost:8001/health

The database is initialized automatically on backend startup for this development starter.

## Test a webhook
1. Create an integration in the dashboard or POST to `/api/integrations`.
2. Copy its returned `webhook_secret` from the API response for local testing only.
3. Create a workflow with a matching `integration_id` and `event_type`.
4. Send a signed webhook using the Python snippet below.

```python
import hashlib, hmac, json, requests

integration_id = "PASTE_INTEGRATION_ID"
secret = "PASTE_WEBHOOK_SECRET"
payload = {
    "event_id": "demo-event-001",
    "event_type": "order.created",
    "data": {"order_id": "A-100", "total": 49.99}
}
body = json.dumps(payload, separators=(",", ":")).encode()
digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
response = requests.post(
    f"http://localhost:8001/api/webhooks/{integration_id}",
    data=body,
    headers={
        "Content-Type": "application/json",
        "X-FlowForge-Signature": f"sha256={digest}",
    },
)
print(response.status_code, response.json())
```

A second request with the same `event_id` for the same integration is marked as a duplicate and does not create another event record.

## Initial API endpoints
- `GET /health`
- `GET /api/integrations`
- `POST /api/integrations`
- `GET /api/workflows`
- `POST /api/workflows`
- `GET /api/events`
- `POST /api/webhooks/{integration_id}`
- `GET /api/executions`
- `GET /api/executions/{execution_id}`

## Important implementation notes
Matching active workflows are now queued to a Celery worker through Redis. The worker executes configured `log` actions and records execution status and logs in PostgreSQL. Each workflow/event pair has one execution record; retryable errors use bounded exponential backoff, controlled by the workflow's `max_retries`. Execution details and logs are available through `GET /api/executions/{execution_id}`.

Terminal workflow failures are analyzed asynchronously by a separate Celery task. Analysis status and validated structured output are stored independently from the execution; provider failures cannot change execution status, errors, logs, or retry counts. The execution detail endpoint includes `failure_analysis` as `null` until an analysis record exists, and then returns its status and (when completed) summary, likely cause, remediation, and confidence.

To enable analysis, copy `.env.example` to `.env` and configure `LLM_API_KEY`, `LLM_MODEL`, and `LLM_BASE_URL` for an OpenAI-compatible chat-completions endpoint. `LLM_TIMEOUT_SECONDS` defaults to 15 seconds and is bounded to 1–30 seconds. The key is passed only to backend/worker containers and is never returned by the API. The failed workflow's event payload, workflow configuration, and persisted logs are sent to this provider for diagnosis; avoid enabling an external provider for sensitive payloads unless its data handling is approved. With missing provider configuration, failed executions remain unchanged and their analysis is marked `Unavailable`; no diagnosis is generated. The test suite mocks the provider and requires no API key.

The new analysis table is created by the existing SQLAlchemy `create_all` startup initialization. Use database migrations for production schema management. Production deployments should also use authentication/authorization, a transactional outbox or equivalent durable enqueueing, rate limits, and secret rotation. Do not expose webhook secrets in a public deployment.

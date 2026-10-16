# FlowForge AI

**An AI-powered workflow automation platform with secure webhooks, asynchronous execution, and intelligent failure analysis.**

FlowForge AI is a full-stack workflow automation platform built for the Edvexa Software Engineering Internship assignment. It receives signed webhook events, matches them to configured workflows, executes actions asynchronously, records execution history, and uses Google Gemini to analyze workflow failures.

## Key Features

- **Integration management:** Register simulated integrations, configure supported event types, and manage webhook signing secrets.
- **Secure webhook ingestion:** Validate HMAC-SHA256 signatures and reject invalid or missing signatures.
- **Duplicate-event protection:** Detect repeated external event IDs per integration and prevent duplicate execution records.
- **Asynchronous workflows:** Execute matching workflows using Celery and Redis.
- **Configurable actions:** Support logging, data transformation, simulated notifications, and HTTP requests.
- **Retry handling:** Apply bounded exponential backoff to retryable failures and track attempts.
- **AI-powered failure analysis:** Generate failure summaries, likely causes, suggested remediation, and confidence scores using Gemini.
- **Rule-based fallback:** Produce structured failure analysis when the AI provider is unavailable or returns invalid output.
- **Execution monitoring:** View integrations, workflows, events, execution statuses, retry information, action logs, and failure analysis in the React dashboard.
- **Automated tests:** Cover webhook validation, duplicate-event handling, workflow execution, retries, and AI fallback behavior.

## Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, Vite, Tailwind CSS |
| Backend | Python, FastAPI |
| Database | PostgreSQL, SQLAlchemy |
| Background processing | Celery, Redis |
| AI failure analysis | Google Gemini API |
| Security | HMAC-SHA256 signature validation |
| Testing | Pytest |
| Development environment | Docker Compose |

## Architecture

```text
Webhook Producer
      |
      v
FastAPI Webhook Endpoint
      |
      +--> Validate HMAC Signature
      |
      +--> Detect Duplicate Event
      |
      +--> Persist Event in PostgreSQL
      |
      +--> Match Active Workflows
                  |
                  v
             Redis Queue
                  |
                  v
             Celery Worker
                  |
                  +--> Execute Workflow Actions
                  |
                  +--> Record Status, Attempts and Logs
                              |
                     +--------+--------+
                     |                 |
                 Completed           Failed
                                       |
                                       v
                              Failure Analysis Task
                                       |
                               Google Gemini API
                                       |
                             Rule-Based Fallback
                                       |
                                       v
                             Persist Analysis Result

React Dashboard <----> FastAPI REST API
```

## Database Schema

FlowForge AI uses PostgreSQL with SQLAlchemy ORM. The relational model enforces referential integrity, idempotency, and cascading log cleanups across 6 core entities:

### Tables and Relationships

1. **`integrations`** — Registered API integrations and webhook target sources.
   - `id` (VARCHAR(36), PK): UUID identifier.
   - `name` (VARCHAR(120), NOT NULL): Human-readable name.
   - `provider` (VARCHAR(80), DEFAULT 'simulated'): Integration provider identifier.
   - `event_types` (JSON, DEFAULT '[]'): Supported event types array.
   - `webhook_secret` (VARCHAR(128), NOT NULL): Secret used for HMAC-SHA256 signature verification.
   - `is_active` (BOOLEAN, DEFAULT TRUE): Active status flag.
   - `created_at` (TIMESTAMP WITH TIME ZONE): Registration timestamp.

2. **`workflows`** — Event-driven automation rules.
   - `id` (VARCHAR(36), PK): UUID identifier.
   - `name` (VARCHAR(120), NOT NULL): Workflow name.
   - `integration_id` (VARCHAR(36), FK `integrations.id`): Parent integration.
   - `event_type` (VARCHAR(120), NOT NULL): Matching trigger event type.
   - `actions` (JSON, DEFAULT '[]'): Array of action configs (`log`, `transform`, `notification`, `http_request`).
   - `max_retries` (INTEGER, DEFAULT 3): Maximum retry attempts allowed.
   - `is_active` (BOOLEAN, DEFAULT TRUE): Active workflow flag.
   - `created_at` (TIMESTAMP WITH TIME ZONE): Creation timestamp.

3. **`webhook_events`** — Ingested and persisted webhook payloads.
   - `id` (VARCHAR(36), PK): UUID identifier.
   - `integration_id` (VARCHAR(36), FK `integrations.id`): Destination integration.
   - `external_event_id` (VARCHAR(200), NOT NULL): Producer's deduplication ID.
   - `event_type` (VARCHAR(120), NOT NULL): Payload event type.
   - `payload` (JSON, NOT NULL): Raw event payload.
   - `received_at` (TIMESTAMP WITH TIME ZONE): Intake timestamp.
   - *Constraint:* `uq_integration_external_event` (`integration_id`, `external_event_id`) guarantees idempotency.

4. **`executions`** — Asynchronous workflow execution runs.
   - `id` (VARCHAR(36), PK): UUID identifier.
   - `workflow_id` (VARCHAR(36), FK `workflows.id`): Triggered workflow.
   - `event_id` (VARCHAR(36), FK `webhook_events.id`): Triggering event.
   - `status` (VARCHAR(20), DEFAULT 'Pending'): `Pending`, `Running`, `Completed`, or `Failed`.
   - `attempt_count` (INTEGER, DEFAULT 0): Execution attempt counter.
   - `started_at` (TIMESTAMP WITH TIME ZONE, NULLABLE): Run start timestamp.
   - `completed_at` (TIMESTAMP WITH TIME ZONE, NULLABLE): Run completion timestamp.
   - `next_attempt_at` (TIMESTAMP WITH TIME ZONE, NULLABLE): Scheduled retry time for backoff.
   - `created_at` (TIMESTAMP WITH TIME ZONE): Creation timestamp.
   - *Constraints:* `uq_execution_workflow_event` (`workflow_id`, `event_id`), `ck_execution_status`, `ck_execution_attempt_count`.

5. **`execution_logs`** — Granular execution output and debugging trail.
   - `id` (VARCHAR(36), PK): UUID identifier.
   - `execution_id` (VARCHAR(36), FK `executions.id`, ON DELETE CASCADE, INDEXED).
   - `level` (VARCHAR(20), NOT NULL): Log severity (`INFO`, `WARNING`, `ERROR`).
   - `message` (TEXT, NOT NULL): Log message or error detail.
   - `created_at` (TIMESTAMP WITH TIME ZONE): Emission timestamp.

6. **`execution_analyses`** — AI diagnostic summaries and rule-based fallbacks.
   - `id` (VARCHAR(36), PK): UUID identifier.
   - `execution_id` (VARCHAR(36), FK `executions.id`, ON DELETE CASCADE, UNIQUE).
   - `status` (VARCHAR(20), DEFAULT 'Pending'): `Pending`, `Running`, `Completed`, `Failed`, or `Unavailable`.
   - `summary` (TEXT, NULLABLE): High-level failure summary.
   - `likely_cause` (TEXT, NULLABLE): Root-cause diagnosis.
   - `suggested_remediation` (TEXT, NULLABLE): Recommended troubleshooting step.
   - `confidence` (FLOAT, NULLABLE): Confidence score between 0.0 and 1.0.
   - `error_message` (TEXT, NULLABLE): Provider failure reason or fallback notice.
   - `created_at` (TIMESTAMP WITH TIME ZONE): Initiation timestamp.
   - `completed_at` (TIMESTAMP WITH TIME ZONE, NULLABLE): Completion timestamp.
   - *Constraints:* `uq_execution_analysis_execution`, `ck_execution_analysis_status`, `ck_execution_analysis_confidence`.

## Prerequisites

- Docker Desktop with Docker Compose
- Git
- A Google Gemini API key for live AI failure analysis

## Run Locally

1. Clone the repository and enter the project directory:

   ```bash
   git clone <YOUR_GITHUB_REPOSITORY_URL>
   cd flowforge-ai-starter
   ```

2. Create your local environment file from the example:

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell, use:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Configure the required environment variables in `.env`. Use the variable names and defaults defined in `.env.example`. Configure the Gemini API key, model, and endpoint for AI failure analysis.

4. Build and start the application:

   ```bash
   docker compose up --build -d
   ```

5. Check the service status:

   ```bash
   docker compose ps
   ```

### Application URLs

- Frontend dashboard: http://localhost:5173
- FastAPI Swagger documentation: http://localhost:8001/docs
- Health check: http://localhost:8001/health

The development environment initializes database tables through SQLAlchemy startup initialization. Production deployments should use database migrations.

## Environment Configuration

Keep `.env` local and never commit API keys or webhook secrets.

The AI configuration uses the following settings in the current development setup:

| Setting | Purpose |
|---|---|
| `LLM_API_KEY` | API key used by the configured AI provider |
| `LLM_MODEL` | Gemini model identifier |
| `LLM_BASE_URL` | Gemini `generateContent` endpoint |
| `LLM_TIMEOUT_SECONDS` | AI request timeout, bounded by the backend |

Confirm the exact variable names and defaults in `.env.example` before configuring your environment.

The API key is used by backend/worker services and should not be returned to frontend clients. Failure-analysis requests may include workflow configuration, event payloads, and execution logs. Avoid sending sensitive data to an external AI provider unless its data-handling practices are approved.

## How to Use FlowForge AI

### 1. Create an integration

Create an integration through the dashboard's integration form or `POST /api/integrations`. Configure the integration name, provider, supported event types, and signing secret as required by the API schema.

For local testing, use a simulated integration. Retrieve its ID from `GET /api/integrations`.

Never expose signing secrets in a public deployment or share them in logs.

### 2. Configure a workflow

Create a workflow using `POST /api/workflows`. Associate it with the relevant integration and event type, configure its actions, and set the retry limit.

The workflow event type must match the incoming webhook event type.

### 3. Send a signed webhook

The webhook endpoint is:

```text
POST /api/webhooks/{integration_id}
```

Example payload:

```json
{
  "event_id": "demo-event-001",
  "event_type": "order.created",
  "data": {
    "order_id": "A-100",
    "total": 49.99
  }
}
```

The server validates the HMAC-SHA256 signature against the exact raw request body. The `X-FlowForge-Signature` header uses this format:

```text
sha256=<hexadecimal-signature>
```

Example Python client:

```python
import hashlib
import hmac
import json
import requests

integration_id = "PASTE_INTEGRATION_ID"
secret = "PASTE_WEBHOOK_SECRET"

payload = {
    "event_id": "demo-event-001",
    "event_type": "order.created",
    "data": {
        "order_id": "A-100",
        "total": 49.99
    }
}

body = json.dumps(
    payload,
    separators=(",", ":")
).encode("utf-8")

digest = hmac.new(
    secret.encode("utf-8"),
    body,
    hashlib.sha256
).hexdigest()

response = requests.post(
    f"http://localhost:8001/api/webhooks/{integration_id}",
    data=body,
    headers={
        "Content-Type": "application/json",
        "X-FlowForge-Signature": f"sha256={digest}",
    },
    timeout=15,
)

print(response.status_code, response.json())
```

Install the client dependency if needed:

```bash
pip install requests
```

A successfully validated webhook returns HTTP `202 Accepted` and indicates whether the event was a duplicate. Matching workflows are queued for asynchronous execution.

Repeated delivery of the same external event ID for the same integration is detected. The worker also protects against repeated claims of the same execution.

### 4. Monitor executions

Open the dashboard and select **Execution history** to inspect workflow statuses, attempt counts, action logs, and failure-analysis results.

You can also inspect executions through the API.

## Workflow Execution and Retries

The backend persists webhook events and creates execution records for matching workflows. Celery workers execute actions asynchronously and record execution status and logs in PostgreSQL.

The execution lifecycle includes:

- `Pending`
- `Running`
- `Completed`
- `Failed`

Retryable failures use bounded exponential backoff. The current implementation's backoff sequence starts at 2, 4, and 8 seconds, subject to the configured maximum. Workflow retry limits determine how many retries are permitted.

Retry behavior depends on the error type. Permanent errors are not retried as if they were transient failures.

## Supported Workflow Actions

- **`log`** — Record a configured message in workflow logs.
- **`transform`** — Transform event data according to the configured action.
- **`notification`** — Execute the simulated notification action; this does not represent delivery through a real messaging provider.
- **`http_request`** — Send an HTTP request to a configured endpoint.

The HTTP action supports configured methods and request data, with timeout and error handling. Treat outbound HTTP actions as a security-sensitive feature; private/internal network protections must be reviewed before public deployment.

## AI Failure Analysis

When a workflow fails, a separate background task analyzes the execution context using the configured Gemini model.

The structured analysis contains:

- **Summary:** A concise explanation of the failure.
- **Likely cause:** The probable reason for the error.
- **Suggested remediation:** A recommended next step.
- **Confidence:** A numeric confidence score.

Analysis is persisted separately from the workflow execution. An analysis-provider failure does not turn a failed workflow into a successful one or modify its retry count.

If the provider is unavailable or the response fails validation, the backend can generate rule-based analysis. The dashboard identifies the source of the analysis.

AI suggestions are diagnostic recommendations, not automatically applied workflow modifications.

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/integrations` | List integrations |
| `POST` | `/api/integrations` | Create an integration |
| `GET` | `/api/workflows` | List workflows |
| `POST` | `/api/workflows` | Create a workflow |
| `GET` | `/api/events` | List webhook events |
| `POST` | `/api/webhooks/{integration_id}` | Receive a signed webhook |
| `GET` | `/api/executions` | List workflow executions |
| `GET` | `/api/executions/{execution_id}` | Get execution details |

Use the interactive Swagger interface at http://localhost:8001/docs to inspect request schemas, required fields, and response formats.

## CodeZero Development Workflow

In accordance with Edvexa development guidelines, [CodeZero](https://frigga.cloud/codezero) was integrated throughout the platform lifecycle:

1. **Architecture Planning & Modeling:**
   - Established non-blocking webhook ingestion decoupling FastAPI from workflow execution using Redis and Celery.
   - Designed database idempotency guarantees using composite unique constraints (`integration_id` + `external_event_id` on events, and `workflow_id` + `event_id` on executions).
   - Modeled independent advisory failure analysis schemas to protect execution immutability.

2. **Incremental Feature Implementation:**
   - Structured atomic commits following Conventional Commits (`feat(actions)`, `feat(analysis)`, `chore(deps)`, `docs`).
   - Implemented 4 extensible action handlers (`log`, `transform`, `notification`, and SSRF-safe `http_request`).
   - Built dual-mode failure diagnostics (Google Gemini LLM with automated rule-based fallback).

3. **Debugging & Reliability Engineering:**
   - Diagnosed transient worker failure cases and established bounded exponential backoff retry algorithms.
   - Designed atomic state claiming (`update(Execution).where(status='Pending').values(status='Running')`) to eliminate worker race conditions.
   - Formulated 21 comprehensive Pytest unit tests mocking external dependencies.

4. **Validation & Quality Assurance:**
   - Validated end-to-end integration registration and workflow creation via interactive dashboard modals.
   - Verified production container builds for both backend and frontend environments.

## Testing

Run the backend test suite inside the Docker container:

```bash
docker compose exec backend pytest -q tests/
```

The current verified result is **21 passed, 3 deprecation warnings**.

The existing suite covers webhook signature validation, rejection of missing signatures, duplicate-event protection, execution idempotency, retry behavior, and rule-based AI fallback. The test suite mocks the AI provider where appropriate and does not require a live API key for those tests.

Build the frontend separately from the `frontend` directory:

```bash
npm run build
```

The production build has been verified successfully.

## Known Limitations and Future Improvements

- Integrations use simulated providers; external integrations require provider-specific adapters.
- Notification actions are simulated and do not send messages through an actual notification provider.
- Authentication and authorization need to be added before exposing the application publicly.
- Production deployments should use database migrations instead of relying on startup `create_all`.
- Durable queue publishing should use a transactional outbox or an equivalent approach to handle database/queue failures safely.
- Outbound HTTP actions need robust private-network/SSRF protections before public deployment.
- Secrets should have a documented rotation process and must never be exposed to clients.
- The frontend and development dependency tree still need a final security review; development-only npm audit findings remain.
- Deprecation warnings from framework dependencies should be addressed in a future maintenance pass.

## Security Notes

- Never commit `.env`, API keys, database credentials, or webhook signing secrets.
- Validate HMAC signatures using the exact raw request body.
- Use HTTPS and authentication/authorization in production.
- Apply rate limiting and request-size limits to public webhook endpoints.
- Review AI data-handling requirements before sending production payloads to an external provider.
- Restrict outbound HTTP actions to approved destinations in production.

## License

Add the license appropriate for your repository and intended distribution.

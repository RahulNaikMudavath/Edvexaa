import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  GitBranch,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Webhook,
} from "lucide-react";

const API = "";

async function getJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      // Keep the HTTP status as a useful error if the response isn't JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

const statusStyles = {
  Pending: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  Running: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  Completed: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
  Failed: "border-rose-400/20 bg-rose-400/10 text-rose-300",
};

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatDuration(createdAt, completedAt) {
  if (!createdAt || !completedAt) return "—";
  const start = new Date(createdAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const diffMs = end - start;
  if (diffMs < 1000) return `${diffMs}ms`;
  const diffSec = (diffMs / 1000).toFixed(1);
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const remSec = (diffSec % 60).toFixed(0);
  return `${mins}m ${remSec}s`;
}

export default function App() {
  const [page, setPage] = useState("overview");
  const [integrations, setIntegrations] = useState([]);
  const [selectedIntegration, setSelectedIntegration] = useState(null);
  const [showIntegrationModal, setShowIntegrationModal] = useState(false);
  const [workflows, setWorkflows] = useState([]);
  const [showWorkflowModal, setShowWorkflowModal] = useState(false);
  const [events, setEvents] = useState([]);
  const [health, setHealth] = useState("Checking");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [executions, setExecutions] = useState([]);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [executionsError, setExecutionsError] = useState("");
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [executionDetail, setExecutionDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  async function refreshOverview() {
    setLoading(true);
    setError("");
    try {
      const [healthData, integrationData, workflowData, eventData, executionData] = await Promise.all([
        getJson("/health"),
        getJson("/api/integrations"),
        getJson("/api/workflows"),
        getJson("/api/events"),
        getJson("/api/executions?limit=200").catch(() => []),
      ]);
      setHealth(healthData.status);
      setIntegrations(integrationData);
      setWorkflows(workflowData);
      setEvents(eventData);
      if (Array.isArray(executionData)) {
        setExecutions(executionData);
      }
    } catch (err) {
      setError(`${err.message}. Is Docker Compose running?`);
      setHealth("Unavailable");
    } finally {
      setLoading(false);
    }
  }

  async function refreshExecutions() {
    setExecutionsLoading(true);
    setExecutionsError("");
    try {
      const records = await getJson("/api/executions?limit=200");
      setExecutions(records);
    } catch (err) {
      setExecutionsError(err.message);
    } finally {
      setExecutionsLoading(false);
    }
  }

  async function openExecution(executionId) {
    setSelectedExecutionId(executionId);
    setExecutionDetail(null);
    setDetailLoading(true);
    setDetailError("");
    try {
      setExecutionDetail(await getJson(`/api/executions/${encodeURIComponent(executionId)}`));
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshCurrentPage() {
    if (page === "executions") {
      await refreshExecutions();
      if (selectedExecutionId) await openExecution(selectedExecutionId);
      return;
    }
    await refreshOverview();
  }

  useEffect(() => {
    refreshOverview();
  }, []);

  useEffect(() => {
    if (page === "executions") refreshExecutions();
  }, [page]);

  useEffect(() => {
    if (
      page !== "executions" ||
      !selectedExecutionId ||
      (executionDetail?.failure_analysis &&
        !["Pending", "Running"].includes(executionDetail.failure_analysis.status)) ||
      (executionDetail && executionDetail.status !== "Failed")
    ) {
      return undefined;
    }
    const interval = window.setInterval(async () => {
      try {
        const updated = await getJson(
          `/api/executions/${encodeURIComponent(selectedExecutionId)}`,
        );
        setExecutionDetail(updated);
        setDetailError("");
      } catch (err) {
        setDetailError(err.message);
      }
    }, 3000);
    return () => window.clearInterval(interval);
  }, [page, selectedExecutionId, executionDetail?.failure_analysis?.status, executionDetail?.status]);

  async function createDemoIntegration() {
    const name = `Demo Integration ${integrations.length + 1}`;
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider: "simulated",
          event_types: ["order.created", "ticket.opened"],
        }),
      });
      if (!response.ok) {
        let message = "Could not create integration";
        try {
          message = (await response.json()).detail || message;
        } catch {
          // Retain the default error when the API doesn't return JSON.
        }
        throw new Error(message);
      }
      const created = await response.json();
      window.alert(
        `Integration created!\nID: ${created.id}\nWebhook secret (save for local testing): ${created.webhook_secret}`,
      );
      await refreshOverview();
    } catch (err) {
      setError(err.message);
    }
  }

  const completedCount = executions.filter((e) => e.status === "Completed").length;
  const failedCount = executions.filter((e) => e.status === "Failed").length;

  const stats = [
    { label: "Integrations", value: integrations.length, icon: Boxes, note: "Registered sources" },
    { label: "Workflows", value: workflows.length, icon: GitBranch, note: "Configured automations" },
    {
      label: "Successful runs",
      value: completedCount,
      icon: CheckCircle2,
      note: "Completed executions",
      highlight: "text-emerald-400",
    },
    {
      label: "Failed runs",
      value: failedCount,
      icon: AlertTriangle,
      note: "Executions needing review",
      highlight: failedCount > 0 ? "text-rose-400" : "text-slate-100",
    },
    { label: "Events received", value: events.length, icon: Webhook, note: "Recent persisted events" },
    {
      label: "API status",
      value: health === "ok" ? "Healthy" : health,
      icon: Activity,
      note: "Backend connectivity",
    },
  ];

  return (
    <div className="min-h-screen bg-[#090e1b] text-slate-100">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-white/10 bg-[#0c1222] p-6 lg:block">
        <Brand />
        <Navigation page={page} setPage={setPage} />
        <div className="absolute bottom-6 left-6 right-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs font-semibold text-slate-300">ASSIGNMENT BUILD</div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Review webhook intake, workflow configurations, and asynchronous execution history.
          </p>
        </div>
      </aside>

      <main className="lg:ml-64">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-6 py-5 md:px-10">
          <div>
            <p className="text-sm text-slate-500">
              Workspace / {page === "executions" ? "Execution history" : "Overview"}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {page === "executions" ? "Execution history" : "Workflow overview"}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {page === "overview" && (
              <>
                <span className={`status-dot ${health === "ok" ? "bg-emerald-400" : "bg-amber-400"}`} />
                <span className="text-sm text-slate-400">API {health}</span>
              </>
            )}
            <button
              className="icon-button"
              onClick={refreshCurrentPage}
              title="Refresh"
              aria-label="Refresh"
              disabled={loading || executionsLoading}
            >
              <RefreshCw
                size={16}
                className={loading || executionsLoading ? "animate-spin" : ""}
              />
            </button>
            {page === "overview" && (
              <button className="primary-button" onClick={() => setShowIntegrationModal(true)}>
                <Plus size={16} /> New integration
              </button>
            )}
          </div>
          <div className="w-full lg:hidden">
            <Navigation page={page} setPage={setPage} mobile />
          </div>
        </header>

        {page === "executions" ? (
          <ExecutionHistory
            executions={executions}
            loading={executionsLoading}
            error={executionsError}
            selectedId={selectedExecutionId}
            detail={executionDetail}
            detailLoading={detailLoading}
            detailError={detailError}
            onOpen={openExecution}
            onRetry={refreshCurrentPage}
          />
        ) : (
          <section className="space-y-8 px-6 py-8 md:px-10">
            {error && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-200">
                <CircleAlert size={18} />
                <span>{error}</span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {stats.map(({ label, value, icon: Icon, note, highlight }) => (
                <div className="panel p-5" key={label}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">{label}</span>
                    <Icon size={18} className="text-violet-300" />
                  </div>
                  <div className={`mt-4 text-3xl font-semibold ${highlight || ""}`}>
                    {loading ? "—" : value}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">{note}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
              <section className="panel overflow-hidden">
                <div className="flex items-center justify-between border-b border-white/10 p-5">
                  <div>
                    <h2 className="font-semibold">Integrations</h2>
                    <p className="mt-1 text-xs text-slate-500">Connected event sources</p>
                  </div>
                  <button
                    className="text-sm text-violet-300 hover:text-violet-200"
                    onClick={() => setShowIntegrationModal(true)}
                  >
                    Add integration <ArrowUpRight size={14} className="inline" />
                  </button>
                </div>
                {integrations.length === 0 ? (
                  <Empty
                    title="No integrations yet"
                    text="Add a simulated integration to create your first webhook endpoint."
                  />
                ) : (
                  <div className="divide-y divide-white/[0.07]">
                    {integrations.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => setSelectedIntegration(item)}
                        className="flex w-full items-center justify-between gap-4 p-5 text-left transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400"
                        aria-label={`View details for ${item.name}`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-cyan-400/10 text-cyan-300">
                            <Webhook size={19} />
                          </div>

                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{item.name}</p>
                            <p className="mt-1 truncate text-xs text-slate-500">
                              {item.provider} · {item.event_types?.join(", ") || "No event types"}
                            </p>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-3">
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs ${
                              item.is_active
                                ? "bg-emerald-400/10 text-emerald-300"
                                : "bg-slate-400/10 text-slate-300"
                            }`}
                          >
                            {item.is_active ? "Active" : "Inactive"}
                          </span>
                          <ArrowUpRight size={16} className="text-slate-500" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="panel overflow-hidden">
                <div className="flex items-center justify-between border-b border-white/10 p-5">
                  <div>
                    <h2 className="font-semibold">Workflow configurations</h2>
                    <p className="mt-1 text-xs text-slate-500">Rules waiting for matching events</p>
                  </div>
                  <button
                    className="flex items-center gap-1.5 rounded-lg border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/20"
                    onClick={() => setShowWorkflowModal(true)}
                  >
                    <Plus size={14} /> New workflow
                  </button>
                </div>
                {workflows.length === 0 ? (
                  <Empty
                    title="No workflows configured"
                    text="Configure a workflow to run actions for matching events."
                  />
                ) : (
                  <div className="divide-y divide-white/[0.07]">
                    {workflows.map((item) => (
                      <div key={item.id} className="p-5">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 size={16} className="text-emerald-300" />
                          <p className="text-sm font-medium">{item.name}</p>
                        </div>
                        <p className="ml-6 mt-1 text-xs text-slate-500">
                          {item.event_type} · {item.actions.length} action(s) · up to{" "}
                          {item.max_retries} retries
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className="panel overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/10 p-5">
                <div>
                  <h2 className="font-semibold">Recent webhook events</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Validated and persisted incoming events
                  </p>
                </div>
                <span className="text-xs text-slate-500">Latest {events.length}</span>
              </div>
              {events.length === 0 ? (
                <Empty
                  title="Waiting for the first event"
                  text="Once an integration is registered, send a correctly signed webhook to populate this feed."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-white/[0.025] text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-5 py-3 font-medium">Event type</th>
                        <th className="px-5 py-3 font-medium">External ID</th>
                        <th className="px-5 py-3 font-medium">Received</th>
                        <th className="px-5 py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {events.map((event) => (
                        <tr key={event.id}>
                          <td className="px-5 py-4 font-medium text-slate-200">
                            {event.event_type}
                          </td>
                          <td className="px-5 py-4 font-mono text-xs text-slate-400">
                            {event.external_event_id}
                          </td>
                          <td className="px-5 py-4 text-xs text-slate-400">
                            {formatDate(event.received_at)}
                          </td>
                          <td className="px-5 py-4">
                            <span className="rounded-full bg-sky-400/10 px-2.5 py-1 text-xs text-sky-300">
                              Persisted
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="rounded-xl border border-violet-400/20 bg-violet-400/[0.06] p-5">
              <p className="text-sm font-medium text-violet-200">
                Asynchronous workflow execution
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-400">
                Matching events are queued to a Celery worker. Review execution statuses, retries,
                and action logs from the Execution History page.
              </p>
            </div>
          </section>
        )}
      </main>

      {selectedIntegration && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedIntegration(null);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="integration-detail-title"
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0c1222] p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-widest text-violet-300">
                  Integration details
                </p>
                <h2
                  id="integration-detail-title"
                  className="mt-2 text-xl font-semibold"
                >
                  {selectedIntegration.name}
                </h2>
              </div>

              <button
                type="button"
                onClick={() => setSelectedIntegration(null)}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5"
                aria-label="Close integration details"
              >
                Close
              </button>
            </div>

            <dl className="mt-6 space-y-4 text-sm">
              <div>
                <dt className="text-slate-500">Integration ID</dt>
                <dd className="mt-1 break-all font-mono text-xs text-slate-200">
                  {selectedIntegration.id}
                </dd>
              </div>

              <div>
                <dt className="text-slate-500">Provider</dt>
                <dd className="mt-1 text-slate-200">
                  {selectedIntegration.provider}
                </dd>
              </div>

              <div>
                <dt className="text-slate-500">Supported event types</dt>
                <dd className="mt-2 flex flex-wrap gap-2">
                  {(selectedIntegration.event_types || []).map((eventType) => (
                    <span
                      key={eventType}
                      className="rounded-full border border-violet-400/20 bg-violet-400/10 px-3 py-1 text-xs text-violet-200"
                    >
                      {eventType}
                    </span>
                  ))}
                  {(!selectedIntegration.event_types ||
                    selectedIntegration.event_types.length === 0) && (
                    <span className="text-slate-400">No event types configured</span>
                  )}
                </dd>
              </div>

              <div>
                <dt className="text-slate-500">Status</dt>
                <dd className="mt-1 text-slate-200">
                  {selectedIntegration.is_active ? "Active" : "Inactive"}
                </dd>
              </div>

              <div>
                <dt className="text-slate-500">Created at</dt>
                <dd className="mt-1 text-slate-200">
                  {formatDate(selectedIntegration.created_at)}
                </dd>
              </div>
            </dl>

            <p className="mt-6 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-200">
              Webhook secrets are not displayed in this details panel.
            </p>
          </section>
        </div>
      )}

      <RegisterIntegrationModal
        isOpen={showIntegrationModal}
        onClose={() => setShowIntegrationModal(false)}
        onCreated={refreshOverview}
      />

      <NewWorkflowModal
        isOpen={showWorkflowModal}
        onClose={() => setShowWorkflowModal(false)}
        integrations={integrations}
        onCreated={refreshOverview}
      />
    </div>
  );
}

function RegisterIntegrationModal({ isOpen, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("simulated");
  const [eventTypesInput, setEventTypesInput] = useState("order.created, ticket.opened");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [createdIntegration, setCreatedIntegration] = useState(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Integration name is required");
      return;
    }
    const eventTypes = eventTypesInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          provider: provider.trim() || "simulated",
          event_types: eventTypes,
        }),
      });
      if (!response.ok) {
        let message = `Failed to create integration (${response.status})`;
        try {
          message = (await response.json()).detail || message;
        } catch {}
        throw new Error(message);
      }
      const data = await response.json();
      setCreatedIntegration(data);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    setName("");
    setProvider("simulated");
    setEventTypesInput("order.created, ticket.opened");
    setError("");
    setCreatedIntegration(null);
    setCopied(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && handleClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="reg-modal-title"
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0c1222] p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-violet-300">
              Integration Management
            </p>
            <h2 id="reg-modal-title" className="mt-1 text-xl font-semibold">
              {createdIntegration ? "Integration Created" : "Register API Integration"}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-xs text-rose-200">
            <CircleAlert size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {createdIntegration ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-xs text-emerald-200">
              Successfully registered <strong>{createdIntegration.name}</strong>! Save the signing secret below.
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-slate-400">Integration ID:</span>
                <p className="mt-1 font-mono text-slate-200">{createdIntegration.id}</p>
              </div>

              <div>
                <span className="text-slate-400">Webhook URL:</span>
                <p className="mt-1 break-all rounded bg-white/[0.04] p-2 font-mono text-violet-300">
                  {window.location.origin}/api/webhooks/{createdIntegration.id}
                </p>
              </div>

              <div>
                <span className="text-slate-400">Webhook Secret (HMAC-SHA256):</span>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    readOnly
                    type="text"
                    value={createdIntegration.webhook_secret || ""}
                    className="w-full rounded border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs text-amber-200"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(createdIntegration.webhook_secret || "");
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="flex shrink-0 items-center gap-1 rounded border border-white/10 bg-white/[0.05] px-3 py-2 text-xs text-slate-200 hover:bg-white/10"
                  >
                    {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-amber-300/80">
                  Keep this secret secure to sign payloads. It is not returned again.
                </p>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="primary-button"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 space-y-4 text-xs">
            <div>
              <label className="block text-slate-400 font-medium">Integration Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Stripe Checkout, GitHub Webhooks"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-violet-400 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 font-medium">Provider</label>
                <input
                  type="text"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="simulated, stripe, etc."
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-violet-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium">Quick Preset</label>
                <button
                  type="button"
                  onClick={() => {
                    setName("Payment Service Integration");
                    setProvider("simulated");
                    setEventTypesInput("payment.succeeded, refund.created");
                  }}
                  className="mt-1.5 w-full rounded-lg border border-violet-400/20 bg-violet-400/10 px-3 py-2 text-xs font-medium text-violet-300 hover:bg-violet-400/20"
                >
                  Use Demo Values
                </button>
              </div>
            </div>

            <div>
              <label className="block text-slate-400 font-medium">
                Supported Event Types (comma-separated)
              </label>
              <input
                type="text"
                value={eventTypesInput}
                onChange={(e) => setEventTypesInput(e.target.value)}
                placeholder="order.created, ticket.opened, user.signup"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-violet-400 focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Incoming webhook events matching these types will be permitted and processed.
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="primary-button"
              >
                {submitting ? "Registering..." : "Register Integration"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function NewWorkflowModal({ isOpen, onClose, integrations, onCreated }) {
  const [name, setName] = useState("");
  const [integrationId, setIntegrationId] = useState("");
  const [eventType, setEventType] = useState("");
  const [maxRetries, setMaxRetries] = useState(3);
  const [actionType, setActionType] = useState("log");
  const [logMessage, setLogMessage] = useState("Workflow executed for event");
  const [notificationRecipient, setNotificationRecipient] = useState("ops-team@company.com");
  const [notificationMessage, setNotificationMessage] = useState("Workflow triggered notification");
  const [httpUrl, setHttpUrl] = useState("https://httpbin.org/post");
  const [httpMethod, setHttpMethod] = useState("POST");
  const [transformFields, setTransformFields] = useState('{"event_id": "event_id"}');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (integrations.length > 0 && !integrationId) {
      setIntegrationId(integrations[0].id);
      if (integrations[0].event_types?.length > 0) {
        setEventType(integrations[0].event_types[0]);
      }
    }
  }, [integrations, integrationId]);

  if (!isOpen) return null;

  const selectedInt = integrations.find((i) => i.id === integrationId);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Workflow name is required");
      return;
    }
    if (!integrationId) {
      setError("Please select an integration");
      return;
    }
    if (!eventType.trim()) {
      setError("Trigger event type is required");
      return;
    }

    let actionConfig = {};
    if (actionType === "log") {
      actionConfig = { message: logMessage.trim() || "Log action executed" };
    } else if (actionType === "notification") {
      actionConfig = {
        recipient: notificationRecipient.trim() || "demo",
        message: notificationMessage.trim() || "Notification sent",
      };
    } else if (actionType === "http_request") {
      actionConfig = {
        url: httpUrl.trim(),
        method: httpMethod,
      };
    } else if (actionType === "transform") {
      try {
        actionConfig = { fields: JSON.parse(transformFields) };
      } catch {
        setError("Transform fields must be valid JSON object, e.g. {\"target\": \"source\"}");
        return;
      }
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          integration_id: integrationId,
          event_type: eventType.trim(),
          max_retries: Number(maxRetries),
          actions: [{ type: actionType, config: actionConfig }],
        }),
      });
      if (!response.ok) {
        let message = `Failed to create workflow (${response.status})`;
        try {
          message = (await response.json()).detail || message;
        } catch {}
        throw new Error(message);
      }
      onCreated();
      handleClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    setName("");
    setError("");
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && handleClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-modal-title"
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0c1222] p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-violet-300">
              Workflow Builder
            </p>
            <h2 id="wf-modal-title" className="mt-1 text-xl font-semibold">
              Create Automation Workflow
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-xs text-rose-200">
            <CircleAlert size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4 text-xs">
          <div>
            <label className="block text-slate-400 font-medium">Workflow Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Notify On Order Created"
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-violet-400 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 font-medium">Target Integration</label>
              <select
                value={integrationId}
                onChange={(e) => {
                  setIntegrationId(e.target.value);
                  const intg = integrations.find((i) => i.id === e.target.value);
                  if (intg?.event_types?.length) {
                    setEventType(intg.event_types[0]);
                  }
                }}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0f172a] px-3 py-2 text-sm text-slate-100 focus:border-violet-400 focus:outline-none"
              >
                {integrations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-400 font-medium">Trigger Event Type</label>
              {selectedInt?.event_types?.length ? (
                <select
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0f172a] px-3 py-2 text-sm text-slate-100 focus:border-violet-400 focus:outline-none"
                >
                  {selectedInt.event_types.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  required
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  placeholder="e.g. order.created"
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 focus:border-violet-400 focus:outline-none"
                />
              )}
            </div>
          </div>

          <div>
            <label className="block text-slate-400 font-medium">Max Retries (on transient failure)</label>
            <input
              type="number"
              min="0"
              max="10"
              value={maxRetries}
              onChange={(e) => setMaxRetries(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 focus:border-violet-400 focus:outline-none"
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
            <div>
              <label className="block text-slate-300 font-medium text-xs">Configured Action</label>
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0f172a] px-3 py-2 text-sm text-slate-100 focus:border-violet-400 focus:outline-none"
              >
                <option value="log">Log Message (Internal Logging)</option>
                <option value="notification">Notification (Simulated Alert)</option>
                <option value="http_request">HTTP Request (Outbound Webhook)</option>
                <option value="transform">Transform Data (Payload Mapping)</option>
              </select>
            </div>

            {actionType === "log" && (
              <div>
                <label className="block text-slate-400">Log Message</label>
                <input
                  type="text"
                  value={logMessage}
                  onChange={(e) => setLogMessage(e.target.value)}
                  className="mt-1 w-full rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200"
                />
              </div>
            )}

            {actionType === "notification" && (
              <div className="space-y-2">
                <div>
                  <label className="block text-slate-400">Recipient</label>
                  <input
                    type="text"
                    value={notificationRecipient}
                    onChange={(e) => setNotificationRecipient(e.target.value)}
                    className="mt-1 w-full rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-slate-400">Message Content</label>
                  <input
                    type="text"
                    value={notificationMessage}
                    onChange={(e) => setNotificationMessage(e.target.value)}
                    className="mt-1 w-full rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200"
                  />
                </div>
              </div>
            )}

            {actionType === "http_request" && (
              <div className="space-y-2">
                <div>
                  <label className="block text-slate-400">Target Endpoint URL</label>
                  <input
                    type="url"
                    value={httpUrl}
                    onChange={(e) => setHttpUrl(e.target.value)}
                    placeholder="https://example.com/api/callback"
                    className="mt-1 w-full rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-slate-400">HTTP Method</label>
                  <select
                    value={httpMethod}
                    onChange={(e) => setHttpMethod(e.target.value)}
                    className="mt-1 w-full rounded border border-white/10 bg-[#0f172a] px-3 py-1.5 text-xs text-slate-200"
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                </div>
              </div>
            )}

            {actionType === "transform" && (
              <div>
                <label className="block text-slate-400">Fields Mapping JSON</label>
                <textarea
                  rows={3}
                  value={transformFields}
                  onChange={(e) => setTransformFields(e.target.value)}
                  className="mt-1 w-full font-mono rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Maps target keys to dot-notation paths in the payload (e.g. &#123;&quot;order_id&quot;: &quot;data.id&quot;&#125;).
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="primary-button"
            >
              {submitting ? "Creating..." : "Create Workflow"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-500/20 text-violet-300">
        <GitBranch size={22} />
      </div>
      <div>
        <div className="font-semibold tracking-tight">
          FlowForge <span className="text-violet-300">AI</span>
        </div>
        <div className="text-xs text-slate-500">Automation control plane</div>
      </div>
    </div>
  );
}

function Navigation({ page, setPage, mobile = false }) {
  const items = [
    { id: "overview", label: "Overview", icon: Activity },
    { id: "executions", label: "Execution history", icon: Clock3 },
  ];
  return (
    <nav
      aria-label="Main navigation"
      className={`${mobile ? "mt-4 flex gap-2 overflow-x-auto" : "mt-12 space-y-2"}`}
    >
      {items.map(({ id, label, icon: Icon }) => (
        <button
          type="button"
          key={id}
          className={`nav-item ${page === id ? "nav-active" : ""} ${
            mobile ? "shrink-0" : "w-full"
          }`}
          onClick={() => setPage(id)}
          aria-current={page === id ? "page" : undefined}
        >
          <Icon size={17} /> {label}
        </button>
      ))}
    </nav>
  );
}

function ExecutionHistory({
  executions,
  loading,
  error,
  selectedId,
  detail,
  detailLoading,
  detailError,
  onOpen,
  onRetry,
}) {
  return (
    <section className="space-y-6 px-6 py-8 md:px-10">
      <div>
        <p className="text-sm text-slate-400">
          Recent asynchronous workflow runs, with their status and action logs.
        </p>
      </div>

      {/* Execution status summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="text-xs font-medium text-slate-400">Total Runs</p>
          <p className="mt-1 text-2xl font-semibold text-slate-100">{executions.length}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4">
          <p className="text-xs font-medium text-emerald-300">Successful</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-400">
            {executions.filter((e) => e.status === "Completed").length}
          </p>
        </div>
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.05] p-4">
          <p className="text-xs font-medium text-rose-300">Failed</p>
          <p className="mt-1 text-2xl font-semibold text-rose-400">
            {executions.filter((e) => e.status === "Failed").length}
          </p>
        </div>
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.05] p-4">
          <p className="text-xs font-medium text-sky-300">In Progress</p>
          <p className="mt-1 text-2xl font-semibold text-sky-400">
            {executions.filter((e) => ["Pending", "Running"].includes(e.status)).length}
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 rounded-xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm text-rose-200"
        >
          <div className="flex items-start gap-3">
            <CircleAlert size={18} className="shrink-0" />
            <span>Could not load execution history: {error}</span>
          </div>
          <button className="text-rose-100 underline" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {loading ? (
        <div className="panel flex items-center justify-center gap-3 p-12 text-sm text-slate-400">
          <LoaderCircle size={18} className="animate-spin text-violet-300" />
          Loading executions…
        </div>
      ) : error ? null : executions.length === 0 ? (
        <div className="panel">
          <Empty
            title="No executions yet"
            text="When an incoming event matches an active workflow, its execution will appear here."
          />
        </div>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/10 p-5">
              <div>
                <h2 className="font-semibold">Executions</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Latest {executions.length} of up to 200
                </p>
              </div>
            </div>
            <div className="divide-y divide-white/[0.07]">
              {executions.map((execution) => (
                <button
                  type="button"
                  key={execution.id}
                  onClick={() => onOpen(execution.id)}
                  className={`block w-full p-5 text-left transition hover:bg-white/[0.03] ${
                    selectedId === execution.id ? "bg-violet-400/[0.07]" : ""
                  }`}
                  aria-label={`View ${execution.workflow_name} execution`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-slate-100">
                        {execution.workflow_name || "Workflow"}
                      </h3>
                      <p className="mt-1 text-xs text-slate-400">
                        {execution.event_type || "Unknown event type"}
                      </p>
                    </div>
                    <StatusBadge status={execution.status} />
                  </div>
                  <dl className="mt-4 grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-slate-500">Execution ID</dt>
                      <dd className="mt-1 truncate font-mono text-slate-300">{execution.id}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Duration</dt>
                      <dd className="mt-1 font-mono text-slate-300">
                        {formatDuration(execution.created_at, execution.completed_at)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Created</dt>
                      <dd className="mt-1 text-slate-300">{formatDate(execution.created_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Attempts</dt>
                      <dd className="mt-1 text-slate-300">
                        {execution.attempt_count} / {execution.max_retries + 1}
                      </dd>
                    </div>
                  </dl>
                </button>
              ))}
            </div>
          </section>

          <ExecutionDetails
            detail={detail}
            loading={detailLoading}
            error={detailError}
            selectedId={selectedId}
            onRetry={onRetry}
          />
        </div>
      )}
    </section>
  );
}


function ExecutionDetails({ detail, loading, error, selectedId, onRetry }) {
  return (
    <section className="panel min-w-0 overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 p-5">
        <div>
          <h2 className="font-semibold">Execution details</h2>
          <p className="mt-1 text-xs text-slate-500">
            Action output and retry information
          </p>
        </div>
        {detail && <StatusBadge status={detail.status} />}
      </div>

      {!selectedId ? (
        <Empty
          title="Select an execution"
          text="Choose a run from the list to inspect its logs and retry details."
        />
      ) : loading ? (
        <div className="flex items-center justify-center gap-3 p-10 text-sm text-slate-400">
          <LoaderCircle size={18} className="animate-spin text-violet-300" />
          Loading execution details…
        </div>
      ) : error ? (
        <div role="alert" className="p-5">
          <div className="flex items-start gap-3 text-sm text-rose-200">
            <CircleAlert size={18} className="shrink-0" />
            <span>Could not load execution details: {error}</span>
          </div>
          <button
            className="mt-4 text-sm text-violet-300 underline"
            onClick={() => onRetry()}
          >
            Refresh execution
          </button>
        </div>
      ) : detail ? (
        <div className="space-y-5 p-5">
          {/* Execution information */}
          <div className="grid gap-4 text-xs sm:grid-cols-2">
            <DetailValue label="Workflow" value={detail.workflow_name} />
            <DetailValue label="Event type" value={detail.event_type} />
            <DetailValue
              label="Created"
              value={formatDate(detail.created_at)}
            />
            <DetailValue
              label="Completed"
              value={formatDate(detail.completed_at)}
            />
            <DetailValue
              label="Duration"
              value={formatDuration(detail.created_at, detail.completed_at)}
            />
            <DetailValue
              label="Total attempts"
              value={`${detail.attempt_count} of ${detail.max_retries + 1}`}
            />
          </div>

          {/* Retry information */}
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
              <RotateCcw size={15} className="text-violet-300" />
              Retry information
            </div>

            <p className="mt-2 text-xs leading-5 text-slate-400">
              {Math.max(0, detail.attempt_count - 1)} retries used of{" "}
              {detail.max_retries} allowed
              <span className="text-slate-500">
                {" "}({detail.attempt_count} total attempts)
              </span>
            </p>

            {detail.next_attempt_at && (
              <p className="mt-1 text-xs text-amber-300">
                Next attempt: {formatDate(detail.next_attempt_at)}
              </p>
            )}
          </div>

          {/* AI failure analysis: render only once */}
          {(detail.failure_analysis || detail.status === "Failed") && (
            <FailureAnalysis analysis={detail.failure_analysis} />
          )}

          {/* Action logs */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-200">
                Action logs
              </h3>
              <span className="text-xs text-slate-500">
                {detail.logs?.length ?? 0} entries
              </span>
            </div>

            {!detail.logs?.length ? (
              <p className="rounded-lg border border-white/[0.07] p-4 text-xs text-slate-500">
                No logs have been recorded for this execution.
              </p>
            ) : (
              <ol className="max-h-[28rem] space-y-2 overflow-y-auto">
                {detail.logs.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex min-w-0 gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-3"
                  >
                    <LogIcon level={entry.level} />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-xs leading-5 text-slate-200">
                        {entry.message}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {formatDate(entry.created_at)} · {entry.level}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}



function FailureAnalysis({ analysis }) {
  return (
    <section className="rounded-xl border border-violet-400/20 bg-violet-400/[0.05] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-violet-200">
          <BrainCircuit size={16} />
          AI failure analysis
        </div>

        {analysis && <StatusBadge status={analysis.status} />}
      </div>

      {!analysis ||
      analysis.status === "Pending" ||
      analysis.status === "Running" ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <LoaderCircle size={14} className="animate-spin text-violet-300" />
          Failure analysis is being prepared.
        </p>
      ) : analysis.status === "Unavailable" ? (
        <p role="status" className="mt-3 text-xs leading-5 text-amber-200">
          {analysis.error_message ||
            "Failure analysis is unavailable. Configure an LLM provider to enable it."}
        </p>
      ) : analysis.status === "Failed" ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-rose-200">
          {analysis.error_message ||
            "Failure analysis could not be completed."}
        </p>
      ) : (
        <div className="mt-4 space-y-4 text-xs leading-5">
          <div>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${
                analysis.analysis_source === "rule_based"
                  ? "bg-amber-400/10 text-amber-200 ring-1 ring-amber-400/20"
                  : "bg-violet-400/10 text-violet-200 ring-1 ring-violet-400/20"
              }`}
            >
              {analysis.analysis_source === "rule_based"
                ? "Rule-based fallback"
                : "AI-generated"}
            </span>
          </div>
          <AnalysisValue
            label="Summary"
            value={analysis.summary}
          />

          <AnalysisValue
            label="Likely cause"
            value={analysis.likely_cause}
          />

          <AnalysisValue
            label="Suggested remediation"
            value={analysis.suggested_remediation}
          />

          <p className="text-slate-400">
            Confidence:{" "}
            <span className="font-medium text-slate-200">
              {typeof analysis.confidence === "number"
                ? `${Math.round(analysis.confidence * 100)}%`
                : "—"}
            </span>
          </p>
        </div>
      )}
    </section>
  );
}

function AnalysisValue({ label, value }) {
  return (
    <div>
      <p className="font-medium text-slate-300">{label}</p>
      <p className="mt-1 break-words text-slate-400">{value || "—"}</p>
    </div>
  );
}

function DetailValue({ label, value }) {
  return (
    <div className="min-w-0">
      <p className="text-slate-500">{label}</p>
      <p className="mt-1 break-words text-slate-200">{value || "—"}</p>
    </div>
  );
}

function StatusBadge({ status }) {
  const Icon =
    status === "Completed"
      ? CheckCircle2
      : status === "Failed"
        ? AlertCircle
        : status === "Running"
          ? LoaderCircle
          : Clock3;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        statusStyles[status] || "border-white/10 bg-white/[0.04] text-slate-300"
      }`}
    >
      <Icon size={13} className={status === "Running" ? "animate-spin" : ""} />
      {status || "Unknown"}
    </span>
  );
}

function LogIcon({ level }) {
  if (level === "ERROR") return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-300" />;
  if (level === "WARNING") return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />;
  return <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-300" />;
}

function Empty({ title, text }) {
  return (
    <div className="px-6 py-10 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04] text-slate-400">
        <Webhook size={18} />
      </div>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500">{text}</p>
    </div>
  );
}

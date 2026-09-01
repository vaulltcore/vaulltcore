// Repository interfaces — neutral seam between pages and either mock or real
// transport. Every read/mutation method accepts an optional `AbortSignal` so
// React Query / components can cancel in-flight requests on unmount or
// re-keyed queries.

import type {
  JobView,
  JobEvent,
  AutomationTemplate,
  AutomationVersion,
  AutomationRun,
  AutomationEvent,
  AutomationArtifact,
  ApprovalRequest,
  SanitizedDelivery,
  ScheduleView,
  OccurrenceView,
  ConnectionView,
  ConnectionCapability,
  TriggerView,
  UsageEventLite,
  UsagePage,
  UsageSummary,
  UsageAggregate,
  RetryStatusItem,
  DeadLetterItem,
  ReliabilityHealthReport,
  ReadinessReport,
  ReconciliationResult,
  TimeoutScanResult,
  AutomationMetrics,
  TriggerDispatch,
} from "@/types";

export interface JobRepository {
  list(opts?: { orgId?: string; projectId?: string }, signal?: AbortSignal): Promise<JobView[]>;
  get(jobId: string, signal?: AbortSignal): Promise<JobView>;
  events(
    jobId: string,
    opts?: { after?: number; follow?: boolean },
    signal?: AbortSignal
  ): Promise<JobEvent[]>;
  cancel(jobId: string, signal?: AbortSignal): Promise<{ status: string }>;
  input(jobId: string, text: string, signal?: AbortSignal): Promise<{ status: string }>;
  usage(
    jobId: string,
    signal?: AbortSignal
  ): Promise<{ jobId: string; usage: Record<string, number> }>;
}

export interface AutomationRepository {
  templates: {
    list(
      opts?: { orgId?: string; projectId?: string },
      signal?: AbortSignal
    ): Promise<{ templates: AutomationTemplate[] }>;
    create(
      body: { name: string; description?: string; orgId?: string; projectId?: string },
      signal?: AbortSignal
    ): Promise<AutomationTemplate>;
    versions(templateId: string, signal?: AbortSignal): Promise<{ versions: AutomationVersion[] }>;
    createVersion(
      templateId: string,
      body: { definition: AutomationVersion["definition"]; inputContract: AutomationVersion["inputContract"] },
      signal?: AbortSignal
    ): Promise<AutomationVersion>;
  };
  runs: {
    list(
      opts?: { orgId?: string; projectId?: string },
      signal?: AbortSignal
    ): Promise<AutomationRun[]>;
    get(runId: string, signal?: AbortSignal): Promise<AutomationRun>;
    events(runId: string, opts?: { after?: number }, signal?: AbortSignal): Promise<{ events: AutomationEvent[] }>;
    artifacts(runId: string, signal?: AbortSignal): Promise<{ artifacts: AutomationArtifact[] }>;
    deliveries(runId: string, signal?: AbortSignal): Promise<{ deliveries: SanitizedDelivery[] }>;
    advance(runId: string, signal?: AbortSignal): Promise<AutomationRun>;
    cancel(runId: string, signal?: AbortSignal): Promise<AutomationRun>;
  };
  approvals: {
    approve(
      id: string,
      metadata?: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<{ approval: ApprovalRequest; run: AutomationRun }>;
    reject(
      id: string,
      metadata?: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<{ approval: ApprovalRequest; run: AutomationRun }>;
    requestChanges(
      id: string,
      metadata?: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<{ approval: ApprovalRequest; run: AutomationRun }>;
  };
}

export interface ScheduleRepository {
  list(
    opts?: { orgId?: string; projectId?: string },
    signal?: AbortSignal
  ): Promise<{ schedules: ScheduleView[] }>;
  get(scheduleId: string, signal?: AbortSignal): Promise<ScheduleView>;
  create(body: Record<string, unknown>, signal?: AbortSignal): Promise<ScheduleView>;
  pause(scheduleId: string, signal?: AbortSignal): Promise<ScheduleView>;
  resume(scheduleId: string, signal?: AbortSignal): Promise<ScheduleView>;
  cancel(scheduleId: string, signal?: AbortSignal): Promise<ScheduleView>;
  occurrences(scheduleId: string, signal?: AbortSignal): Promise<{ occurrences: OccurrenceView[] }>;
}

export interface ConnectionRepository {
  capabilities(_: void, signal?: AbortSignal): Promise<{ capabilities: ConnectionCapability[] }>;
  list(opts?: { family?: string }, signal?: AbortSignal): Promise<{ connections: ConnectionView[] }>;
  get(connectionId: string, signal?: AbortSignal): Promise<ConnectionView>;
  create(
    body: { provider: string; redirectUri: string; method?: string; scopes?: string[]; codeVerifier?: string },
    signal?: AbortSignal
  ): Promise<{ attemptId: string; state: string; authorizeUrl: string; codeChallenge: string }>;
  reconnect(
    connectionId: string,
    body: { redirectUri: string },
    signal?: AbortSignal
  ): Promise<{ attemptId: string; state: string; authorizeUrl: string }>;
  refresh(connectionId: string, signal?: AbortSignal): Promise<ConnectionView>;
  disconnect(connectionId: string, signal?: AbortSignal): Promise<ConnectionView>;
}

export interface TriggerRepository {
  list(_: void, signal?: AbortSignal): Promise<{ triggers: TriggerView[] }>;
  get(triggerId: string, signal?: AbortSignal): Promise<TriggerView>;
  create(body: Record<string, unknown>, signal?: AbortSignal): Promise<TriggerView>;
  enable(triggerId: string, signal?: AbortSignal): Promise<TriggerView>;
  disable(triggerId: string, signal?: AbortSignal): Promise<TriggerView>;
  invoke(triggerId: string, signal?: AbortSignal): Promise<{ dispatches: TriggerDispatch[]; runIds: string[] }>;
  dispatch(dispatchId: string, signal?: AbortSignal): Promise<TriggerDispatch>;
}

export interface UsageRepository {
  list(
    params?: {
      cursor?: string;
      limit?: number;
      from?: number;
      to?: number;
      kind?: string;
      provider?: string;
      model?: string;
      runId?: string;
    },
    signal?: AbortSignal
  ): Promise<UsagePage>;
  summary(
    params?: { from?: number; to?: number; kind?: string; provider?: string; model?: string },
    signal?: AbortSignal
  ): Promise<UsageSummary>;
  run(runId: string, signal?: AbortSignal): Promise<UsageAggregate>;
  ledger(
    params?: { cursor?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<UsagePage>;
}

export interface OperationsRepository {
  retryStatus(
    opts?: { kind?: string; state?: string },
    signal?: AbortSignal
  ): Promise<{ items: RetryStatusItem[] }>;
  health(_: void, signal?: AbortSignal): Promise<ReliabilityHealthReport>;
  deadLetter(
    _: void,
    signal?: AbortSignal
  ): Promise<{ items: RetryStatusItem[]; deadLetter: DeadLetterItem[]; dispatchDeadLetter: DeadLetterItem[] }>;
  redrive(id: string, signal?: AbortSignal): Promise<unknown>;
  dispatchRedrive(id: string, signal?: AbortSignal): Promise<unknown>;
  reconcile(scope: void | "all", signal?: AbortSignal): Promise<ReconciliationResult>;
  timeoutScan(_: void, signal?: AbortSignal): Promise<TimeoutScanResult>;
  readiness(_: void, signal?: AbortSignal): Promise<ReadinessReport>;
}

export interface MetricsRepository {
  get(_: void, signal?: AbortSignal): Promise<AutomationMetrics>;
}

export interface AppRepositories {
  jobs: JobRepository;
  automation: AutomationRepository;
  schedules: ScheduleRepository;
  connections: ConnectionRepository;
  triggers: TriggerRepository;
  usage: UsageRepository;
  operations: OperationsRepository;
  metrics: MetricsRepository;
}
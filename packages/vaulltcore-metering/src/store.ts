/**
 * SQL-backed metering store (Phase 1E).
 *
 * Append-only usage events with a UNIQUE `(tenant_id, job_id, kind, dedup_key)`
 * identity. A duplicate delivery is recorded exactly once: the INSERT uses
 * `ON CONFLICT DO NOTHING` and a 0-change result is reported as a duplicate
 * (not an error), so a worker retry that re-delivers the same committed event
 * cannot double-record usage.
 */

import { randomBytes } from "node:crypto"
import { SqlStoreBase, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import { type RecordResult, type UsageAggregate, type UsageEvent, type UsageEventInput, type UsageKind, MeteringError } from "./contracts"

export const METERING_MIGRATIONS: readonly Migration[] = [
  {
    version: 5,
    name: "metering_usage_events",
    statements: [
      `CREATE TABLE usage_events (
        event_id   TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        org_id     TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job_id     TEXT NOT NULL,
        kind       TEXT NOT NULL,
        quantity   INTEGER NOT NULL,
        dedup_key  TEXT NOT NULL,
        unit       TEXT,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (event_id),
        UNIQUE (tenant_id, job_id, kind, dedup_key)
      )`,
      `CREATE INDEX usage_events_job_idx ON usage_events (tenant_id, job_id)`,
      `CREATE INDEX usage_events_scope_idx ON usage_events (tenant_id, org_id, project_id)`,
    ],
  },
]

interface UsageEventRow {
  event_id: string
  tenant_id: string
  org_id: string
  project_id: string
  job_id: string
  kind: string
  quantity: number
  dedup_key: string
  unit: string | null
  recorded_at: number
}

function toEvent(row: UsageEventRow): UsageEvent {
  return {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind as UsageKind,
    quantity: row.quantity,
    dedupKey: row.dedup_key,
    unit: row.unit,
    recordedAt: row.recorded_at,
  }
}

export interface MeteringStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlMeteringStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: MeteringStoreOptions = {}) {
    super(db, METERING_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  private id(): string {
    return `use_${randomBytes(12).toString("base64url")}`
  }

  /**
   * Record a usage event exactly once. Returns the persisted event and whether
   * it was a duplicate of an already-recorded event. A duplicate is NOT an
   * error — it proves the worker-retry safety property.
   */
  async record(input: UsageEventInput): Promise<RecordResult> {
    const now = Date.now()
    return this.atomic("recordUsage", () => {
      const eventId = this.id()
      const result = this.prepare(
        `INSERT INTO usage_events (event_id, tenant_id, org_id, project_id, job_id, kind, quantity, dedup_key, unit, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, job_id, kind, dedup_key) DO NOTHING`,
      ).run(
        eventId,
        input.identity.tenantId,
        input.identity.orgId,
        input.identity.projectId,
        input.identity.jobId,
        input.kind,
        input.quantity,
        input.dedupKey,
        input.unit ?? null,
        now,
      )
      if (result.changes === 0) {
        const existing = this.prepare(
          "SELECT * FROM usage_events WHERE tenant_id = ? AND job_id = ? AND kind = ? AND dedup_key = ?",
        ).get(input.identity.tenantId, input.identity.jobId, input.kind, input.dedupKey) as unknown as UsageEventRow
        return { event: toEvent(existing), duplicated: true }
      }
      const row = this.prepare("SELECT * FROM usage_events WHERE event_id = ?").get(eventId) as unknown as UsageEventRow
      return { event: toEvent(row), duplicated: false }
    })
  }

  /** Record a batch of usage events atomically (all-or-nothing). */
  async recordBatch(inputs: readonly UsageEventInput[]): Promise<RecordResult[]> {
    if (inputs.length === 0) return []
    return this.atomic("recordUsageBatch", () =>
      inputs.map((input) => {
        const now = Date.now()
        const eventId = this.id()
        const result = this.prepare(
          `INSERT INTO usage_events (event_id, tenant_id, org_id, project_id, job_id, kind, quantity, dedup_key, unit, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, job_id, kind, dedup_key) DO NOTHING`,
        ).run(
          eventId,
          input.identity.tenantId,
          input.identity.orgId,
          input.identity.projectId,
          input.identity.jobId,
          input.kind,
          input.quantity,
          input.dedupKey,
          input.unit ?? null,
          now,
        )
        if (result.changes === 0) {
          const existing = this.prepare(
            "SELECT * FROM usage_events WHERE tenant_id = ? AND job_id = ? AND kind = ? AND dedup_key = ?",
          ).get(input.identity.tenantId, input.identity.jobId, input.kind, input.dedupKey) as unknown as UsageEventRow
          return { event: toEvent(existing), duplicated: true }
        }
        const row = this.prepare("SELECT * FROM usage_events WHERE event_id = ?").get(eventId) as unknown as UsageEventRow
        return { event: toEvent(row), duplicated: false }
      }),
    )
  }

  async listEvents(scope: { tenantId: string; jobId: string }): Promise<UsageEvent[]> {
    const rows = this.prepare("SELECT * FROM usage_events WHERE tenant_id = ? AND job_id = ? ORDER BY recorded_at ASC, event_id ASC").all(scope.tenantId, scope.jobId) as unknown as unknown as UsageEventRow[]
    return rows.map(toEvent)
  }

  /** Aggregate usage for a job (tenant-scoped; cross-tenant reads return empty). */
  async aggregateJob(tenantId: string, jobId: string): Promise<UsageAggregate> {
    const rows = this.prepare("SELECT kind, quantity FROM usage_events WHERE tenant_id = ? AND job_id = ?").all(tenantId, jobId) as Array<{ kind: string; quantity: number }>
    return aggregateRows(rows, jobId)
  }

  /** Aggregate usage for a scope (tenant/org/project). */
  async aggregateScope(scope: { tenantId: string; orgId: string; projectId: string }): Promise<UsageAggregate> {
    const rows = this.prepare("SELECT kind, quantity FROM usage_events WHERE tenant_id = ? AND org_id = ? AND project_id = ?").all(scope.tenantId, scope.orgId, scope.projectId) as Array<{ kind: string; quantity: number }>
    return aggregateRows(rows, null)
  }
}

function aggregateRows(rows: Array<{ kind: string; quantity: number }>, jobId: string | null): UsageAggregate {
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let steps = 0
  let toolCalls = 0
  let durationMs = 0
  let totalTokens = 0
  for (const row of rows) {
    switch (row.kind as UsageKind) {
      case "model_tokens": {
        // quantity encodes input/output/reasoning as a structured payload split
        // across three events with distinct dedupKey suffixes; sum all as total.
        totalTokens += row.quantity
        break
      }
      case "model_request":
        steps += row.quantity
        break
      case "tool_call":
        toolCalls += row.quantity
        break
      case "execution_duration":
        durationMs += row.quantity
        break
    }
  }
  return { jobId, inputTokens, outputTokens, reasoningTokens, totalTokens, steps, toolCalls, durationMs }
}

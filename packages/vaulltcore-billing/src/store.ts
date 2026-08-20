/**
 * SQL-backed billing ledger (Phase 1E).
 *
 * The ledger is append-only and idempotent: every charge references a pricing
 * version that is immutable, and a UNIQUE `(tenant_id, org_id, project_id,
 * idempotency_key)` constraint means a duplicate usage event / re-delivery
 * creates exactly one charge (ON CONFLICT DO NOTHING, 0 changes = duplicate).
 *
 * No external payment processor: this phase implements internal accounting
 * primitives only (charge/debit, adjustment/credit, idempotent settlement).
 */

import { randomBytes } from "node:crypto"
import { SqlStoreBase, isUniqueViolation, type Migration, type SqlDialect, type SqlDatabase } from "@vaulltcore/store-sql"
import type { UsageKind } from "@vaulltcore/metering"
import {
  type AccountBalance,
  type BillingScope,
  type ChargeInput,
  type LedgerEntry,
  type LedgerEntryType,
  type PricingVersion,
  type SettleUsageInput,
  type SettleUsageResult,
  type UsageSettlement,
  type SettlementState,
  BillingError,
} from "./contracts"

export const BILLING_MIGRATIONS: readonly Migration[] = [
  {
    version: 6,
    name: "billing_ledger",
    statements: [
      `CREATE TABLE pricing_versions (
        pricing_id   TEXT PRIMARY KEY,
        version      TEXT NOT NULL,
        unit_prices  TEXT NOT NULL,
        effective_at INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1
      )`,
      `CREATE UNIQUE INDEX pricing_active_idx ON pricing_versions (active) WHERE active = 1`,
      `CREATE TABLE ledger_entries (
        entry_id        TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        org_id           TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        job_id           TEXT,
        type             TEXT NOT NULL,
        amount           INTEGER NOT NULL,
        pricing_id       TEXT NOT NULL,
        pricing_version  TEXT NOT NULL,
        source_ref       TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        UNIQUE (tenant_id, org_id, project_id, idempotency_key)
      )`,
      `CREATE INDEX ledger_scope_idx ON ledger_entries (tenant_id, org_id, project_id)`,
      `CREATE INDEX ledger_job_idx ON ledger_entries (tenant_id, job_id)`,
    ],
  },
  {
    // Phase 1F: durable usage→ledger settlement tracking. Each usage event is
    // settled exactly once: the (tenant_id, event_id) PRIMARY KEY + state
    // machine guarantee one authoritative outcome. Pricing is resolved against
    // an immutable PricingVersion referenced by id+version; a later price change
    // can never rewrite a settled entry. If pricing cannot be resolved, the
    // event is marked `unresolved` (durable, surfaced to reconciliation) — never
    // silently dropped. `non_billable` carries a durable reason.
    version: 11,
    name: "usage_settlement",
    statements: [
      `CREATE TABLE usage_settlement (
        tenant_id       TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        job_id          TEXT NOT NULL,
        org_id          TEXT NOT NULL,
        project_id      TEXT NOT NULL,
        kind            TEXT NOT NULL,
        quantity        INTEGER NOT NULL,
        state           TEXT NOT NULL,
        pricing_id      TEXT,
        pricing_version TEXT,
        ledger_entry_id TEXT,
        amount_micro    INTEGER,
        non_billable_reason TEXT,
        settled_at      INTEGER,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, event_id)
      )`,
      `CREATE INDEX usage_settlement_state_idx ON usage_settlement (tenant_id, state)`,
      `CREATE INDEX usage_settlement_job_idx ON usage_settlement (tenant_id, job_id)`,
    ],
  },
]

interface PricingRow {
  pricing_id: string
  version: string
  unit_prices: string
  effective_at: number
  created_at: number
  active: number
}

interface LedgerRow {
  entry_id: string
  tenant_id: string
  org_id: string
  project_id: string
  job_id: string | null
  type: string
  amount: number
  pricing_id: string
  pricing_version: string
  source_ref: string
  idempotency_key: string
  created_at: number
}

function toPricing(row: PricingRow): PricingVersion {
  return {
    pricingId: row.pricing_id,
    version: row.version,
    unitPrices: JSON.parse(row.unit_prices) as Record<UsageKind, number>,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  }
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    entryId: row.entry_id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    jobId: row.job_id,
    type: row.type as LedgerEntryType,
    amount: row.amount,
    pricingId: row.pricing_id,
    pricingVersion: row.pricing_version,
    sourceRef: row.source_ref,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }
}

/** Default micro-currency price table (1 unit = 1 micro-cent equivalent). */
export const DEFAULT_PRICING: PricingVersion = {
  pricingId: "default-pricing",
  version: "1",
  unitPrices: {
    model_tokens: 2, // 2 micro per token
    model_request: 500, // 0.5 cent per request
    tool_call: 100,
    execution_duration: 1, // 1 micro per ms
    environment_allocation: 50,
    snapshot_storage: 1, // 1 micro per byte-ms (flat here)
  },
  effectiveAt: 0,
  createdAt: 0,
}

export interface BillingStoreOptions {
  readonly dialect?: SqlDialect
  readonly beforeCommit?: (op: string) => void
}

export class SqlBillingStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: BillingStoreOptions = {}) {
    super(db, BILLING_MIGRATIONS, { ...(options.dialect ? { dialect: options.dialect } : {}), beforeCommit: options.beforeCommit })
  }

  /** Create (or supersede) a pricing version. Returns the stored version. */
  async createPricingVersion(pricing: PricingVersion, active = true): Promise<PricingVersion> {
    const now = Date.now()
    this.atomic("createPricing", () => {
      if (active) {
        this.prepare("UPDATE pricing_versions SET active = 0 WHERE active = 1").run()
      }
      try {
        this.prepare("INSERT INTO pricing_versions (pricing_id, version, unit_prices, effective_at, created_at, active) VALUES (?, ?, ?, ?, ?, ?)").run(
          pricing.pricingId,
          pricing.version,
          JSON.stringify(pricing.unitPrices),
          pricing.effectiveAt,
          now,
          active ? 1 : 0,
        )
      } catch (error) {
        if (isUniqueViolation(error)) throw new BillingError("PRICING_EXISTS", `Pricing ${pricing.pricingId} already exists`)
        throw error
      }
    })
    return { ...pricing, createdAt: now }
  }

  /** The currently-active pricing version (fallback to default). */
  async getActivePricing(): Promise<PricingVersion> {
    const row = this.prepare("SELECT * FROM pricing_versions WHERE active = 1").get() as unknown as PricingRow | undefined
    return row ? toPricing(row) : { ...DEFAULT_PRICING }
  }

  /** Historical pricing lookup (a ledger entry pins its version; this is for
   *  inspection/audit). */
  async getPricing(pricingId: string): Promise<PricingVersion | null> {
    const row = this.prepare("SELECT * FROM pricing_versions WHERE pricing_id = ?").get(pricingId) as unknown as PricingRow | undefined
    return row ? toPricing(row) : null
  }

  /**
   * Idempotently record a charge. The entry references the pricing version used
   * (immutable); a later price change never rewrites this charge. A duplicate
   * (same idempotency key) returns the existing entry instead of creating a
   * second charge. Returns `{ entry, duplicated }`.
   */
  async charge(input: ChargeInput, pricing: PricingVersion): Promise<{ entry: LedgerEntry; duplicated: boolean }> {
    const now = Date.now()
    const unitPrice = pricing.unitPrices[input.kind] ?? 0
    const amount = unitPrice * input.quantity
    return this.atomic("charge", () => {
      const entryId = `led_${randomBytes(12).toString("base64url")}`
      const result = this.prepare(
        `INSERT INTO ledger_entries (entry_id, tenant_id, org_id, project_id, job_id, type, amount, pricing_id, pricing_version, source_ref, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'charge', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, org_id, project_id, idempotency_key) DO NOTHING`,
      ).run(
        entryId,
        input.identity.tenantId,
        input.identity.orgId,
        input.identity.projectId,
        input.identity.jobId,
        amount,
        pricing.pricingId,
        pricing.version,
        input.sourceRef,
        input.idempotencyKey,
        now,
      )
      if (result.changes === 0) {
        const existing = this.prepare(
          "SELECT * FROM ledger_entries WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND idempotency_key = ?",
        ).get(input.identity.tenantId, input.identity.orgId, input.identity.projectId, input.idempotencyKey) as unknown as LedgerRow
        return { entry: toEntry(existing), duplicated: true }
      }
      const row = this.prepare("SELECT * FROM ledger_entries WHERE entry_id = ?").get(entryId) as unknown as LedgerRow
      return { entry: toEntry(row), duplicated: false }
    })
  }

  /** Idempotently record an adjustment/credit (negative amount). */
  async adjust(input: ChargeInput, pricing: PricingVersion, amountMicro: number): Promise<{ entry: LedgerEntry; duplicated: boolean }> {
    const now = Date.now()
    return this.atomic("adjust", () => {
      const entryId = `led_${randomBytes(12).toString("base64url")}`
      const result = this.prepare(
        `INSERT INTO ledger_entries (entry_id, tenant_id, org_id, project_id, job_id, type, amount, pricing_id, pricing_version, source_ref, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, org_id, project_id, idempotency_key) DO NOTHING`,
      ).run(
        entryId,
        input.identity.tenantId,
        input.identity.orgId,
        input.identity.projectId,
        input.identity.jobId,
        -amountMicro,
        pricing.pricingId,
        pricing.version,
        input.sourceRef,
        input.idempotencyKey,
        now,
      )
      if (result.changes === 0) {
        const existing = this.prepare(
          "SELECT * FROM ledger_entries WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND idempotency_key = ?",
        ).get(input.identity.tenantId, input.identity.orgId, input.identity.projectId, input.idempotencyKey) as unknown as LedgerRow
        return { entry: toEntry(existing), duplicated: true }
      }
      const row = this.prepare("SELECT * FROM ledger_entries WHERE entry_id = ?").get(entryId) as unknown as LedgerRow
      return { entry: toEntry(row), duplicated: false }
    })
  }

  /** Charge a job's aggregated usage against a pricing version (idempotent by
   *  job id + kind). Used at job completion to bill consumed resources. */
  async chargeJobUsage(
    identity: BillingScope,
    kind: UsageKind,
    quantity: number,
    pricing: PricingVersion,
  ): Promise<{ entry: LedgerEntry; duplicated: boolean }> {
    const jobId = identity.jobId ?? "scope"
    return this.charge(
      {
        identity,
        kind,
        quantity,
        sourceRef: `usage:${jobId}:${kind}`,
        idempotencyKey: `charge:${identity.tenantId}:${identity.orgId}:${identity.projectId}:${jobId}:${kind}`,
      },
      pricing,
    )
  }

  async listEntries(scope: { tenantId: string; orgId: string; projectId: string }): Promise<LedgerEntry[]> {
    const rows = this.prepare("SELECT * FROM ledger_entries WHERE tenant_id = ? AND org_id = ? AND project_id = ? ORDER BY created_at ASC").all(scope.tenantId, scope.orgId, scope.projectId) as unknown as unknown as LedgerRow[]
    return rows.map(toEntry)
  }

  async listJobEntries(tenantId: string, jobId: string): Promise<LedgerEntry[]> {
    const rows = this.prepare("SELECT * FROM ledger_entries WHERE tenant_id = ? AND job_id = ? ORDER BY created_at ASC").all(tenantId, jobId) as unknown as unknown as LedgerRow[]
    return rows.map(toEntry)
  }

  async getBalance(scope: { tenantId: string; orgId: string; projectId: string }): Promise<AccountBalance> {
    const rows = this.prepare("SELECT type, amount FROM ledger_entries WHERE tenant_id = ? AND org_id = ? AND project_id = ?").all(scope.tenantId, scope.orgId, scope.projectId) as Array<{ type: string; amount: number }>
    let balance = 0
    let charges = 0
    let credits = 0
    for (const row of rows) {
      if (row.type === "charge") {
        balance += row.amount
        charges += row.amount
      } else {
        balance += row.amount // adjustment is negative
        credits += -row.amount
      }
    }
    return { tenantId: scope.tenantId, orgId: scope.orgId, projectId: scope.projectId, balance, charges, credits }
  }

  // -------------------------------------------------------------------------
  // Phase 1F: durable usage→ledger settlement
  // -------------------------------------------------------------------------

  /**
   * Settle one usage event through the durable pipeline:
   *
   *   classify billable/non-billable → resolve immutable PricingVersion
   *   → calculate charge → create exactly one LedgerEntry → mark settled
   *
   * Idempotent: the (tenant_id, event_id) PRIMARY KEY + the ledger's
   * UNIQUE(tenant_id,org_id,project_id,idempotency_key) collapse duplicate
   * deliveries/retries to one outcome. Pricing is resolved against the ACTIVE
   * PricingVersion at settlement time and recorded immutably; a later price
   * change never rewrites a settled entry (corrections are NEW adjustment
   * entries). If pricing cannot be resolved, the event is marked `unresolved`
   * (durable, surfaced to reconciliation) — never silently dropped.
   *
   * `classify` lets the caller decide billable vs non-billable (e.g. a
   * cancellation settles only genuinely consumed resources). Returning
   * `{ billable: false, reason }` marks the event `non_billable` with a durable
   * reason and creates no charge.
   */
  async settleUsage(
    input: SettleUsageInput,
    options: {
      classify?: (input: SettleUsageInput) => { billable: true } | { billable: false; reason: string }
    } = {},
  ): Promise<SettleUsageResult> {
    const now = Date.now()
    return this.atomic("settleUsage", (): SettleUsageResult => {
      // Upsert a pending settlement row (idempotent on (tenant, event)).
      this.prepare(
        `INSERT INTO usage_settlement (tenant_id, event_id, job_id, org_id, project_id, kind, quantity, state, pricing_id, pricing_version, ledger_entry_id, amount_micro, non_billable_reason, settled_at, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)
         ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      ).run(input.tenantId, input.eventId, input.jobId, input.orgId, input.projectId, input.kind, input.quantity, now, now)
      const existing = this.getSettlementRow(input.tenantId, input.eventId)!

      // Terminal states are idempotent: return the recorded outcome.
      if (existing.state === "settled" || existing.state === "non_billable") {
        const ledger = existing.ledger_entry_id ? this.prepare("SELECT * FROM ledger_entries WHERE entry_id = ?").get(existing.ledger_entry_id) as unknown as LedgerRow | undefined : undefined
        return { settlement: toSettlement(existing), ledgerEntry: ledger ? toEntry(ledger) : null, duplicated: true }
      }

      // Bump attempt counter on every (re)try of a non-terminal event.
      this.prepare("UPDATE usage_settlement SET attempts = attempts + 1, updated_at = ? WHERE tenant_id = ? AND event_id = ?").run(now, input.tenantId, input.eventId)

      // Classification: default billable.
      const classification = options.classify ? options.classify(input) : { billable: true } as const
      if (!classification.billable) {
        this.prepare(
          "UPDATE usage_settlement SET state = 'non_billable', non_billable_reason = ?, settled_at = ?, updated_at = ? WHERE tenant_id = ? AND event_id = ?",
        ).run(classification.reason, now, now, input.tenantId, input.eventId)
        const settled = this.getSettlementRow(input.tenantId, input.eventId)!
        return { settlement: toSettlement(settled), ledgerEntry: null, duplicated: false }
      }

      // Resolve pricing. No active pricing → unresolved (durable, retryable).
      const pricing = this.prepare("SELECT * FROM pricing_versions WHERE active = 1").get() as unknown as PricingRow | undefined
      if (!pricing) {
        this.prepare(
          "UPDATE usage_settlement SET state = 'unresolved', last_error = ?, updated_at = ? WHERE tenant_id = ? AND event_id = ?",
        ).run("no active pricing version", now, input.tenantId, input.eventId)
        const unresolved = this.getSettlementRow(input.tenantId, input.eventId)!
        return { settlement: toSettlement(unresolved), ledgerEntry: null, duplicated: false }
      }
      const unitPrice = (JSON.parse(pricing.unit_prices) as Record<UsageKind, number>)[input.kind] ?? 0
      const amount = unitPrice * input.quantity

      // Create exactly one ledger entry (idempotent on idempotency_key).
      const idempotencyKey = `settle:${input.tenantId}:${input.eventId}`
      const entryId = `led_${randomBytes(12).toString("base64url")}`
      const chargeResult = this.prepare(
        `INSERT INTO ledger_entries (entry_id, tenant_id, org_id, project_id, job_id, type, amount, pricing_id, pricing_version, source_ref, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, 'charge', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, org_id, project_id, idempotency_key) DO NOTHING`,
      ).run(entryId, input.tenantId, input.orgId, input.projectId, input.jobId, amount, pricing.pricing_id, pricing.version, input.eventId, idempotencyKey, now)
      let ledger: LedgerRow
      let duplicated: boolean
      if (chargeResult.changes === 0) {
        ledger = this.prepare("SELECT * FROM ledger_entries WHERE tenant_id = ? AND org_id = ? AND project_id = ? AND idempotency_key = ?").get(input.tenantId, input.orgId, input.projectId, idempotencyKey) as unknown as LedgerRow
        duplicated = true
      } else {
        ledger = this.prepare("SELECT * FROM ledger_entries WHERE entry_id = ?").get(entryId) as unknown as LedgerRow
        duplicated = false
      }

      // Mark settled, pinning the immutable pricing reference + ledger link.
      this.prepare(
        "UPDATE usage_settlement SET state = 'settled', pricing_id = ?, pricing_version = ?, ledger_entry_id = ?, amount_micro = ?, settled_at = ?, last_error = NULL, updated_at = ? WHERE tenant_id = ? AND event_id = ?",
      ).run(ledger.pricing_id, ledger.pricing_version, ledger.entry_id, ledger.amount, now, now, input.tenantId, input.eventId)
      const settled = this.getSettlementRow(input.tenantId, input.eventId)!
      return { settlement: toSettlement(settled), ledgerEntry: toEntry(ledger), duplicated }
    })
  }

  /** Mark a usage event durably unresolved (pricing/operator issue). */
  async markUsageUnresolved(tenantId: string, eventId: string, reason: string): Promise<UsageSettlement | null> {
    const now = Date.now()
    return this.atomic("markUsageUnresolved", (): UsageSettlement | null => {
      const row = this.getSettlementRow(tenantId, eventId)
      if (!row) return null
      if (row.state === "settled" || row.state === "non_billable") return toSettlement(row)
      this.prepare("UPDATE usage_settlement SET state = 'unresolved', last_error = ?, updated_at = ? WHERE tenant_id = ? AND event_id = ?").run(reason, now, tenantId, eventId)
      return toSettlement(this.getSettlementRow(tenantId, eventId)!)
    })
  }

  /** Retry a previously-unresolved settlement now that pricing may exist. */
  async retrySettlement(input: SettleUsageInput, options: { classify?: (input: SettleUsageInput) => { billable: true } | { billable: false; reason: string } } = {}): Promise<SettleUsageResult> {
    return this.settleUsage(input, options)
  }

  /** Read a settlement record (no transition). */
  getUsageSettlement(tenantId: string, eventId: string): UsageSettlement | null {
    const row = this.getSettlementRow(tenantId, eventId)
    return row ? toSettlement(row) : null
  }

  /** All settlement records for a job (tenant-scoped). */
  listJobSettlements(tenantId: string, jobId: string): UsageSettlement[] {
    const rows = this.prepare("SELECT * FROM usage_settlement WHERE tenant_id = ? AND job_id = ? ORDER BY created_at ASC").all(tenantId, jobId) as unknown as SettlementRow[]
    return rows.map(toSettlement)
  }

  /** Settlement records in a given state (backlog inspection). */
  listSettlementsByState(tenantId: string, state: SettlementState): UsageSettlement[] {
    const rows = this.prepare("SELECT * FROM usage_settlement WHERE tenant_id = ? AND state = ? ORDER BY updated_at ASC").all(tenantId, state) as unknown as SettlementRow[]
    return rows.map(toSettlement)
  }

  private getSettlementRow(tenantId: string, eventId: string): SettlementRow | null {
    return (this.prepare("SELECT * FROM usage_settlement WHERE tenant_id = ? AND event_id = ?").get(tenantId, eventId) as unknown as SettlementRow | undefined) ?? null
  }
}

interface SettlementRow {
  tenant_id: string
  event_id: string
  job_id: string
  org_id: string
  project_id: string
  kind: string
  quantity: number
  state: string
  pricing_id: string | null
  pricing_version: string | null
  ledger_entry_id: string | null
  amount_micro: number | null
  non_billable_reason: string | null
  settled_at: number | null
  attempts: number
  last_error: string | null
  created_at: number
  updated_at: number
}

function toSettlement(row: SettlementRow): UsageSettlement {
  return {
    tenantId: row.tenant_id,
    eventId: row.event_id,
    jobId: row.job_id,
    orgId: row.org_id,
    projectId: row.project_id,
    kind: row.kind as UsageKind,
    quantity: row.quantity,
    state: row.state as SettlementState,
    pricingId: row.pricing_id,
    pricingVersion: row.pricing_version,
    ledgerEntryId: row.ledger_entry_id,
    amountMicro: row.amount_micro,
    nonBillableReason: row.non_billable_reason,
    settledAt: row.settled_at,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

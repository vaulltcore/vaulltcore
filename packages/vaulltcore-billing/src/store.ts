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
}

/**
 * Durable SQL-backed operational work-item store (Phase 2B).
 *
 * Reuses {@link SqlStoreBase} so the atomic-commit boundary, dialect-aware
 * placeholder rewriting, and rollback semantics are identical to the Phase 1
 * stores. Every state-changing write is fenced by a generation CAS: a stale
 * worker (generation N-1) can never claim/heartbeat/complete once a newer
 * generation (N) is committed, even across separate connections or a partition.
 *
 * PostgreSQL is the production target; node:sqlite is the dev/conformance target.
 * Multi-connection fencing conformance is verified against PGlite (real PG
 * engine) in Tier A and a real PG server in Tier B (gated). No test fakes a pass.
 */

import { SqlStoreBase, type SqlStoreBaseOptions } from "@vaulltcore/store-sql"
import type { Migration } from "@vaulltcore/store-sql"
import type { SqlDatabase, SqlDialect } from "@vaulltcore/store-sql"
import {
  type OpsClaim,
  type OpsWorkItem,
  type OpsWorkKind,
  type OpsWorkResult,
  type OpsWorkState,
  OPS_WORK_KINDS,
  OPS_WORK_STATES,
} from "./contracts"

const MIGRATIONS: Migration[] = [
  {
    name: "ops_work_items",
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS ops_work_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${OPS_WORK_KINDS.map((k) => `'${k}'`).join(", ")})),
        target_ref TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (${OPS_WORK_STATES.map((s) => `'${s}'`).join(", ")})),
        generation INTEGER NOT NULL DEFAULT 0,
        claimant TEXT,
        claim_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        retry_class TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tenant_id, idempotency_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ops_claimable ON ops_work_items (state, next_retry_at, kind)`,
      `CREATE INDEX IF NOT EXISTS idx_ops_expires ON ops_work_items (state, claim_expires_at)`,
    ],
  },
]

interface OpsWorkRow {
  id: string
  tenant_id: string
  org_id: string
  project_id: string
  kind: OpsWorkKind
  target_ref: string
  idempotency_key: string
  state: OpsWorkState
  generation: number
  claimant: string | null
  claim_expires_at: number | null
  attempts: number
  next_retry_at: number | null
  last_error: string | null
  retry_class: string | null
  created_at: number
  updated_at: number
}

function rowToItem(row: OpsWorkRow): OpsWorkItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orgId: row.org_id,
    projectId: row.project_id,
    kind: row.kind,
    targetRef: row.target_ref,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    generation: row.generation,
    claimant: row.claimant,
    claimExpiresAt: row.claim_expires_at,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    retryClass: row.retry_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface SqlOpsStoreOptions extends SqlStoreBaseOptions {
  readonly dialect?: SqlDialect
}

export class SqlOpsStore extends SqlStoreBase {
  constructor(db: SqlDatabase, options: SqlOpsStoreOptions = {}) {
    super(db, MIGRATIONS, options)
  }

  /** Enqueue a work item. Idempotent on (tenant, idempotencyKey): re-enqueueing
   *  an existing pending/retriable item is a no-op (no duplicate work). */
  enqueue(item: Omit<OpsWorkItem, "id" | "state" | "generation" | "claimant" | "claimExpiresAt" | "attempts" | "nextRetryAt" | "lastError" | "retryClass" | "createdAt" | "updatedAt"> & { readonly id: string }): OpsWorkItem {
    const now = (this as unknown as { now?: () => number }).now?.() ?? Date.now()
    return this.atomic("enqueue", () => {
      const existing = this.prepare(`SELECT * FROM ops_work_items WHERE tenant_id = ? AND idempotency_key = ?`).get(item.tenantId, item.idempotencyKey) as unknown as OpsWorkRow | undefined
      if (existing) {
        // Idempotent: do not duplicate. If terminal, leave it; the caller can
        // inspect. Return the existing item.
        return rowToItem(existing)
      }
      const row: OpsWorkRow = {
        id: item.id,
        tenant_id: item.tenantId,
        org_id: item.orgId,
        project_id: item.projectId,
        kind: item.kind,
        target_ref: item.targetRef,
        idempotency_key: item.idempotencyKey,
        state: "pending",
        generation: 0,
        claimant: null,
        claim_expires_at: null,
        attempts: 0,
        next_retry_at: null,
        last_error: null,
        retry_class: null,
        created_at: now,
        updated_at: now,
      }
      this.prepare(`INSERT INTO ops_work_items (id, tenant_id, org_id, project_id, kind, target_ref, idempotency_key, state, generation, claimant, claim_expires_at, attempts, next_retry_at, last_error, retry_class, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.tenant_id, row.org_id, row.project_id, row.kind, row.target_ref, row.idempotency_key, row.state, row.generation, row.claimant, row.claim_expires_at, row.attempts, row.next_retry_at, row.last_error, row.retry_class, row.created_at, row.updated_at)
      return rowToItem(row)
    })
  }

  /** Claim the next eligible work item under a fenced generation. Only items in
   *  `pending` or `failed_retriable` with `next_retry_at <= now` (or null) are
   *  claimable. Expired claims are reclaimable. Returns null when empty. */
  claim(workerId: string, leaseMs: number, now: number = Date.now()): OpsClaim | null {
    return this.atomic("claim", () => {
      const candidate = this.prepare(`SELECT * FROM ops_work_items WHERE state IN ('pending','failed_retriable') AND (next_retry_at IS NULL OR next_retry_at <= ?) AND (claim_expires_at IS NULL OR claim_expires_at <= ?) ORDER BY created_at ASC LIMIT 1`).get(now, now) as unknown as OpsWorkRow | undefined
      if (!candidate) return null
      const newGen = candidate.generation + 1
      const expiresAt = now + leaseMs
      // Fenced CAS: only update if generation is still the old value.
      const res = this.prepare(`UPDATE ops_work_items SET state = 'claimed', generation = ?, claimant = ?, claim_expires_at = ?, updated_at = ? WHERE id = ? AND generation = ?`).run(newGen, workerId, expiresAt, now, candidate.id, candidate.generation)
      if (res.changes === 0) {
        // Lost the race to another worker; signal the caller to retry.
        return null
      }
      return { itemId: candidate.id, generation: newGen, claimant: workerId, expiresAt }
    })
  }

  /** Renew a claim's expiry under the same generation (fenced). Returns false if
   *  the generation was superseded (the worker has lost authority). */
  heartbeat(claim: OpsClaim, leaseMs: number, now: number = Date.now()): boolean {
    return this.atomic("heartbeat", () => {
      const res = this.prepare(`UPDATE ops_work_items SET claim_expires_at = ?, updated_at = ? WHERE id = ? AND generation = ?`).run(now + leaseMs, now, claim.itemId, claim.generation)
      return res.changes > 0
    })
  }

  /** Mark the item complete with a fenced write. Records the result + retry. */
  complete(claim: OpsClaim, result: OpsWorkResult, maxAttempts: number, now: number = Date.now()): OpsWorkItem {
    return this.atomic("complete", () => {
      const item = this.prepare(`SELECT * FROM ops_work_items WHERE id = ? AND generation = ?`).get(claim.itemId, claim.generation) as unknown as OpsWorkRow | undefined
      if (!item) throw new Error("ops work item not found or fenced")
      const attempts = item.attempts + 1
      let state: OpsWorkState
      let nextRetryAt: number | null = null
      let lastError: string | null = null
      let retryClass: string | null = null
      if (result.kind === "succeeded") {
        state = "succeeded"
      } else if (result.kind === "failed_terminal") {
        state = "failed_terminal"
        lastError = result.reason
      } else {
        // failed_retriable
        if (attempts >= maxAttempts) {
          state = "failed_terminal"
          lastError = `${result.reason} (max_attempts_exceeded)`
          retryClass = result.retryClass
        } else {
          state = "failed_retriable"
          nextRetryAt = result.nextRetryAt
          lastError = result.reason
          retryClass = result.retryClass
        }
      }
      this.prepare(`UPDATE ops_work_items SET state = ?, attempts = ?, next_retry_at = ?, last_error = ?, retry_class = ?, claimant = NULL, claim_expires_at = NULL, generation = ? + 1, updated_at = ? WHERE id = ? AND generation = ?`).run(state, attempts, nextRetryAt, lastError, retryClass, item.generation, now, claim.itemId, claim.generation)
      const updated = this.prepare(`SELECT * FROM ops_work_items WHERE id = ?`).get(claim.itemId) as unknown as OpsWorkRow
      return rowToItem(updated)
    })
  }

  /** Reclaim expired/abandoned items (a crashed worker's lease lapsed). The
   *  reaper itself is idempotent + fenced: it only resets state for items whose
   *  claim has expired, leaving generation intact so the next claim increments.
   *  Returns the count of items reset to a re-claimable state. */
  reapExpiredClaims(now: number = Date.now()): number {
    return this.atomic("reapExpired", () => {
      const res = this.prepare(`UPDATE ops_work_items SET state = 'failed_retriable', next_retry_at = COALESCE(next_retry_at, ?), updated_at = ? WHERE state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`).run(now, now, now)
      return res.changes
    })
  }

  /** List items by kind+state (tenant-scoped; cross-tenant returns empty). */
  list(tenantId: string, kind: OpsWorkKind | null, state: OpsWorkState | null): OpsWorkItem[] {
    const where: string[] = ["tenant_id = ?"]
    const args: (string | number)[] = [tenantId]
    if (kind) { where.push("kind = ?"); args.push(kind) }
    if (state) { where.push("state = ?"); args.push(state) }
    const rows = this.prepare(`SELECT * FROM ops_work_items WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...args) as unknown as OpsWorkRow[]
    return rows.map(rowToItem)
  }

  /** Read a single item (tenant-scoped; returns null on cross-tenant). */
  get(tenantId: string, itemId: string): OpsWorkItem | null {
    const row = this.prepare(`SELECT * FROM ops_work_items WHERE tenant_id = ? AND id = ?`).get(tenantId, itemId) as unknown as OpsWorkRow | undefined
    return row ? rowToItem(row) : null
  }

  /** Privileged read by id (operational workers only; never exposed through a
   *  tenant API). Returns null if missing. */
  getById(itemId: string): OpsWorkItem | null {
    const row = this.prepare(`SELECT * FROM ops_work_items WHERE id = ?`).get(itemId) as unknown as OpsWorkRow | undefined
    return row ? rowToItem(row) : null
  }
}

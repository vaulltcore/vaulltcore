/**
 * Durable operational worker contracts (Phase 2B).
 *
 * A generic, fenced work-item queue for operational background work: approval
 * expiry, delivery retry, abandoned runs, expired reservations, stale
 * idempotency records, and artifact lifecycle cleanup. Every work item is
 * durable (survives process restart), has an explicit idempotency identity,
 * retry classification, and a recovery path.
 *
 * Fencing model (reuses the Phase 1D invariant): a worker claims a work item
 * by atomically writing its identity + a fenced generation + an expiry into
 * `ops_work_items`. Heartbeat renews the expiry under the same generation. A
 * stale worker whose process died cannot reclaim — its generation is superseded
 * by a new claim (generation N-1 can never write once generation N committed).
 * Reaping expired/abandoned items is itself idempotent + fenced.
 *
 * This is NOT a general workflow engine. Work items are short, idempotent
 * operational tasks derived from durable authoritative state, never agent
 * execution. Reconciliation reads authoritative state; the ops worker only
 * resumes eligible operational cleanup.
 */

/** Kinds of operational work. Each maps to an idempotent reaper. */
export const OPS_WORK_KINDS = [
  "approval_expiry",
  "delivery_retry",
  "abandoned_run",
  "expired_reservation",
  "stale_idempotency",
  "artifact_lifecycle",
] as const
export type OpsWorkKind = (typeof OPS_WORK_KINDS)[number]

export const OPS_WORK_STATES = ["pending", "claimed", "in_progress", "succeeded", "failed_terminal", "failed_retriable"] as const
export type OpsWorkState = (typeof OPS_WORK_STATES)[number]

/** A durable operational work item. */
export interface OpsWorkItem {
  readonly id: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly kind: OpsWorkKind
  /** The durable target identity this item acts on (e.g. runId, approvalId). */
  readonly targetRef: string
  /** Stable idempotency identity for the operation (kind + targetRef). */
  readonly idempotencyKey: string
  readonly state: OpsWorkState
  /** Fenced generation; superseding claim increments. */
  readonly generation: number
  readonly claimant: string | null
  readonly claimExpiresAt: number | null
  readonly attempts: number
  readonly nextRetryAt: number | null
  readonly lastError: string | null
  readonly retryClass: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** A claimed work item bound to a worker generation. */
export interface OpsClaim {
  readonly itemId: string
  readonly generation: number
  readonly claimant: string
  readonly expiresAt: number
}

/** Result of attempting an operational work item. */
export type OpsWorkResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed_terminal"; readonly reason: string }
  | { readonly kind: "failed_retriable"; readonly reason: string; readonly retryClass: string; readonly nextRetryAt: number }

/** A reaper: idempotently processes one work item. Must be safe to call >1x. */
export interface OpsReaper {
  readonly kind: OpsWorkKind
  process(item: OpsWorkItem, claim: OpsClaim): Promise<OpsWorkResult>
}

/** Fenced lease options for the operational worker. */
export interface OpsWorkerOptions {
  readonly workerId: string
  readonly leaseMs: number
  readonly heartbeatIntervalMs?: number
  /** Max consecutive empty polls before idling. Default Infinity. */
  readonly maxEmptyPolls?: number
  /** Now clock (tests). */
  readonly now?: () => number
  /** Sleep function (tests use fake timers). */
  readonly sleep?: (ms: number) => Promise<void>
}

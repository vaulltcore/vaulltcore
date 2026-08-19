/**
 * Metering model (Phase 1E).
 *
 * Raw usage facts are durable, append-only, and idempotent. A mutable
 * `job.cost` field is NOT accounting truth — the metering ledger is. A
 * {@link UsageEvent} has a stable idempotency/deduplication identity
 * (`(job_id, source, dedup_key)`), so a duplicate or worker-retry delivery of
 * the same event is recorded exactly once (UNIQUE constraint + ON CONFLICT DO
 * NOTHING). Execution remains at-least-once; metering is exactly-once at the
 * durable event-identity boundary.
 */

import type { JobIdentity } from "@vaulltcore/runner"

export const USAGE_KINDS = [
  "model_tokens",
  "model_request",
  "tool_call",
  "execution_duration",
  "environment_allocation",
  "snapshot_storage",
] as const
export type UsageKind = (typeof USAGE_KINDS)[number]

/** An immutable usage fact. */
export interface UsageEvent {
  readonly eventId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly jobId: string
  /** What was consumed. */
  readonly kind: UsageKind
  /** Quantity (tokens, count, milliseconds, bytes...). */
  readonly quantity: number
  /** Stable deduplication identity within (jobId, kind). */
  readonly dedupKey: string
  /** Optional unit hint (tokens, ms, bytes). */
  readonly unit: string | null
  readonly recordedAt: number
}

/** Aggregated usage for a job (or scope). */
export interface UsageAggregate {
  readonly jobId: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly steps: number
  readonly toolCalls: number
  readonly durationMs: number
}

export class MeteringError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "MeteringError"
  }
}

export interface UsageEventInput {
  readonly identity: JobIdentity & { jobId: string }
  readonly kind: UsageKind
  readonly quantity: number
  readonly dedupKey: string
  readonly unit?: string
}

/** Result of recording a usage event (distinguishes first insert vs duplicate). */
export interface RecordResult {
  readonly event: UsageEvent
  readonly duplicated: boolean
}

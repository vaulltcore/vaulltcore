/**
 * Durable store boundary. The runner never trusts process memory for
 * authoritative state: job records, the append-only event log, and the latest
 * checkpoint all live behind this interface.
 *
 * Phase 1A ships a single-node file implementation. The interface is shaped
 * so a transactional database implementation (with real cross-worker lease
 * CAS) can replace it without touching the runner.
 */

import type { JobCheckpoint, JobEvent, JobRecord, NewJobEvent } from "./contracts"

export interface LeaseGrant {
  readonly attempt: number
  readonly leaseToken: string
  readonly leaseExpiresAt: number
}

export interface DurableJobStore {
  createJobRecord(record: JobRecord): Promise<void>
  getJobRecord(jobId: string): Promise<JobRecord | null>
  /** Atomic compare-and-swap on the record; `expectedAttempt` fences stale workers. */
  updateJobRecord(
    jobId: string,
    expectedAttempt: number,
    mutate: (record: JobRecord) => Partial<JobRecord>,
  ): Promise<JobRecord>
  /**
   * Acquire (or steal, when expired) the lease. Increments the ownership
   * generation (attempt) and returns a fencing token. Throws when a live
   * lease is held by another token.
   */
  acquireLease(jobId: string, leaseToken: string, leaseMs: number): Promise<LeaseGrant>
  /** Explicitly release ownership (no-op when already released). */
  releaseLease?(jobId: string, leaseToken: string): Promise<void>
  /**
   * Append events; assigns monotonic seq starting at 1. Atomic per batch.
   * When `expectedAttempt` is supplied, stale ownership generations are
   * rejected (Phase 1B ownership fencing: one authoritative writer).
   */
  appendEvents<T>(jobId: string, events: readonly NewJobEvent<T>[], expectedAttempt?: number): Promise<JobEvent<T>[]>
  listEvents(jobId: string, afterSeq?: number): Promise<JobEvent[]>
  /** Persist the latest checkpoint; rejects writes from a stale attempt. */
  saveCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void>
  getCheckpoint(jobId: string): Promise<JobCheckpoint | null>
}

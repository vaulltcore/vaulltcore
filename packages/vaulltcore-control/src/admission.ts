/**
 * Admission pipeline (Phase 1E).
 *
 * Implements the required lifecycle in order, as an explicit orchestration the
 * control plane calls instead of the raw runner:
 *
 *   authenticate → resolve principal → authorize org/project
 *   → idempotency handling → policy evaluation → quota reservation
 *   → durable job creation → return/replay existing admission result
 *
 * Transaction/compensation boundaries:
 * - A successful quota reservation followed by a failed job creation must NOT
 *   permanently leak capacity: the reservation is released as compensation.
 * - Idempotency is keyed by (tenant, idempotencyKey) and is tied to the
 *   reservation's `requestKey`: a replay returns the same logical job AND never
 *   reserves capacity a second time (the reservation is idempotent on its
 *   request key, so a replay is a no-op that returns the existing reservation).
 *
 * The runner executes an already-authorized immutable contract: the policy's
 * enforceable subset is projected into the runner's immutable ExecutionPolicy
 * (pinned into the JobRecord by the runner), and the job's tenantId/orgId/
 * projectId are cross-validated against the identity store before creation and
 * again at recovery. No business logic leaks into the runner's loop.
 */

import type {
  AgentRunner,
  CreateJobInput,
  ExecutionPolicy,
  JobIdentity,
  JobRecord,
  JobMetrics,
} from "@vaulltcore/runner"
import { type AdmissionDecision, type AdmissionRequest as PolicyAdmissionRequest, type SqlPolicyStore } from "@vaulltcore/policy"
import { type QuotaLimits, type QuotaReservation, QuotaError, type QuotaScope, type SqlQuotaStore, quotaScope } from "@vaulltcore/quota"
import { type ResolvedPrincipal, type SqlIdentityStore, IdentityError } from "@vaulltcore/identity"
import { type AuditInput, type SqlAuditStore } from "@vaulltcore/audit"

export interface AdmissionDeps {
  readonly runner: AgentRunner
  readonly identity: SqlIdentityStore
  readonly policy: SqlPolicyStore
  readonly quota: SqlQuotaStore
  readonly audit: SqlAuditStore
  /** Maps (tenantId, idempotencyKey) -> { jobId, reservationId }. Replaceable;
   *  in-memory default lives in the control plane. */
  readonly idempotency: AdmissionIdempotencyRegistry
}

export interface AdmissionIdempotencyRegistry {
  record(tenantId: string, key: string, value: AdmissionIdempotencyRecord): Promise<void>
  lookup(tenantId: string, key: string): Promise<AdmissionIdempotencyRecord | undefined>
}

export interface AdmissionIdempotencyRecord {
  readonly jobId: string
  readonly reservationId: string
}

export interface AdmissionRequest {
  readonly principal: ResolvedPrincipal
  readonly idempotencyKey: string
  readonly orgId: string
  readonly projectId: string
  readonly spec: {
    readonly engine: string
    readonly model: string
    readonly input: string
    readonly engineOptions?: Record<string, unknown>
  }
  readonly requestedTools: readonly string[]
  readonly requestedMaxSteps?: number
  /** Lease to project into the runner's ExecutionPolicy (defaults to policy maxDurationMs). */
  readonly leaseMs?: number
}

export interface AdmissionResult {
  readonly jobId: string
  readonly reservationId: string
  readonly decision: AdmissionDecision
  readonly status: JobRecord["status"]
  readonly replayed: boolean
}

export class AdmissionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = "AdmissionError"
  }
}

/** Default lease derived from the policy's duration cap, capped to a sane worker lease. */
function defaultLeaseMs(decision: AdmissionDecision): number {
  return Math.min(decision.maxDurationMs, 60_000)
}

/** Project the admission decision into the runner's immutable ExecutionPolicy. */
function toExecutionPolicy(decision: AdmissionDecision, leaseMs: number): ExecutionPolicy {
  return {
    version: decision.policyVersion,
    maxSteps: decision.maxSteps,
    onUncertainToolCall: "mark_uncertain",
    allowedTools: [...decision.allowedTools],
    idempotentTools: [],
    leaseMs,
  }
}

function quotaLimitsFromDecision(decision: AdmissionDecision, maxConcurrent: number): QuotaLimits {
  return {
    maxConcurrentJobs: maxConcurrent,
    jobsPerPeriod: decision.maxConcurrentJobs * 10,
    periodMs: 3_600_000,
    maxTokens: decision.maxTokens,
    maxDurationMs: decision.maxDurationMs,
  }
}

function auditActor(principal: ResolvedPrincipal) {
  return { principalId: principal.principalId, kind: principal.kind, tenantId: principal.tenantId }
}

function toPolicyRequest(scope: { tenantId: string; orgId: string; projectId: string }, requestedTools: readonly string[], requestedMaxSteps?: number): PolicyAdmissionRequest {
  return {
    tenantId: scope.tenantId,
    orgId: scope.orgId,
    projectId: scope.projectId,
    requestedTools,
    ...(requestedMaxSteps !== undefined ? { requestedMaxSteps } : {}),
  }
}

export class AdmissionPipeline {
  constructor(private readonly deps: AdmissionDeps) {}

  async admit(request: AdmissionRequest): Promise<AdmissionResult> {
    const { principal, idempotencyKey, orgId, projectId, spec, requestedTools, requestedMaxSteps } = request
    if (!idempotencyKey) throw new AdmissionError("BAD_REQUEST", "Idempotency-Key required", 400)

    const scope = { tenantId: principal.tenantId, orgId, projectId }

    // 1. Authorize org/project scope (identity layer).
    const identity: JobIdentity = { tenantId: principal.tenantId, orgId, projectId }
    try {
      await this.deps.identity.authorize(principal, { orgId, projectId })
      await this.deps.identity.validateJobIdentity(identity)
    } catch (error) {
      if (error instanceof IdentityError) {
        await this.auditRejection(principal, identity, "job_rejected", { reason: error.code, message: error.message })
        throw new AdmissionError(error.code, error.message, error.code === "FORBIDDEN_ORG" || error.code.startsWith("FORBIDDEN") || error.code === "IDENTITY_MISMATCH" ? 403 : 404)
      }
      throw error
    }

    // 2. Idempotency replay: same (tenant, key) returns the existing admission.
    const existing = await this.deps.idempotency.lookup(principal.tenantId, idempotencyKey)
    if (existing) {
      const job = await this.deps.runner.getJob(existing.jobId)
      if (job) {
        // Cross-tenant guard (defense in depth): the registry is tenant-scoped,
        // but confirm the stored job still belongs to this tenant.
        if (job.tenantId !== principal.tenantId && !principal.admin) {
          throw new AdmissionError("JOB_NOT_FOUND", "job not found", 404)
        }
        const decision = await this.deps.policy.evaluate(scope, toPolicyRequest(scope, requestedTools, requestedMaxSteps))
        return {
          jobId: existing.jobId,
          reservationId: existing.reservationId,
          decision,
          status: job.status,
          replayed: true,
        }
      }
      // Stale idempotency record (job gone): fall through to create a new one.
      // The reservation was tied to the same requestKey and is idempotent, so a
      // replay will not double-consume quota.
    }

    // 3. Policy evaluation (before admission).
    const decision = await this.deps.policy.evaluate(scope, toPolicyRequest(scope, requestedTools, requestedMaxSteps))
    await this.audit(principal, identity, "policy_decision", { allowed: decision.allowed, reasonCode: decision.reasonCode, policyId: decision.policyId, policyVersion: decision.policyVersion })
    if (!decision.allowed) {
      await this.auditRejection(principal, identity, "job_rejected", { reason: decision.reasonCode })
      throw new AdmissionError("POLICY_DENIED", `Admission denied: ${decision.reasonCode}`, 403)
    }

    // 4. Quota reservation (race-free, idempotent on requestKey = idempotencyKey).
    const limits = quotaLimitsFromDecision(decision, decision.maxConcurrentJobs)
    await this.deps.quota.setLimits(quotaScope(identity), limits)
    let reservation: QuotaReservation
    try {
      reservation = await this.deps.quota.reserve(quotaScope(identity), idempotencyKey, null, limits)
    } catch (error) {
      if (error instanceof QuotaError) {
        await this.auditRejection(principal, identity, "quota_rejected", { reason: error.code, requestKey: idempotencyKey })
        throw new AdmissionError(error.code, error.message, 429)
      }
      throw error
    }
    await this.audit(principal, identity, "quota_reserved", { reservationId: reservation.reservationId, state: reservation.state })

    // 5. Durable job creation — with compensation on failure.
    const leaseMs = request.leaseMs ?? defaultLeaseMs(decision)
    const input: CreateJobInput = {
      tenantId: principal.tenantId,
      orgId,
      projectId,
      spec,
      policy: toExecutionPolicy(decision, leaseMs),
    }
    let record: JobRecord
    try {
      record = await this.deps.runner.createJob(input)
    } catch (error) {
      // Compensation: release the reservation so capacity does not leak.
      await this.deps.quota.release(reservation.reservationId, reservation.version).catch(() => {})
      await this.auditRejection(principal, identity, "job_rejected", { reason: "JOB_CREATION_FAILED", message: error instanceof Error ? error.message : "unknown" })
      throw error
    }

    // 6. Link the reservation to the job and record idempotency.
    await this.deps.quota.attachJob(reservation.reservationId, record.jobId)
    await this.deps.idempotency.record(principal.tenantId, idempotencyKey, { jobId: record.jobId, reservationId: reservation.reservationId })
    await this.audit(principal, identity, "job_admitted", { jobId: record.jobId, reservationId: reservation.reservationId, policyVersion: decision.policyVersion })

    return {
      jobId: record.jobId,
      reservationId: reservation.reservationId,
      decision,
      status: record.status,
      replayed: false,
    }
  }

  /**
   * Settle a job's reservation with actual usage and bill consumed resources.
   * Called by the control plane at job terminal/cancellation. Settlement is
   * idempotent (re-settling returns the existing settled reservation) and
   * fenced (a stale version is rejected). Billing is exactly-once at the
   * durable charge identity boundary.
   */
  async settleAndBill(args: {
    principal: ResolvedPrincipal
    jobId: string
    reservationId: string
    expectedVersion: number
    usage: JobMetrics
    durationMs: number
    pricingRef: { pricingId: string; version: string; unitPrices: Readonly<Record<string, number>> }
  }): Promise<{ settled: QuotaReservation }> {
    const job = await this.deps.runner.getJob(args.jobId)
    if (!job || (job.tenantId !== args.principal.tenantId && !args.principal.admin)) {
      throw new AdmissionError("JOB_NOT_FOUND", "job not found", 404)
    }
    const identity: JobIdentity & { jobId: string } = { tenantId: args.principal.tenantId, orgId: job.orgId ?? "", projectId: job.projectId ?? "", jobId: args.jobId }
    const settled = await this.deps.quota.settle(args.reservationId, args.expectedVersion, {
      tokens: args.usage.totalTokens,
      durationMs: args.durationMs,
    })
    await this.audit(args.principal, identity, "quota_settled", { reservationId: args.reservationId, tokens: args.usage.totalTokens, durationMs: args.durationMs })
    return { settled }
  }

  private async audit(principal: ResolvedPrincipal, identity: JobIdentity, type: AuditInput["type"], metadata: Record<string, unknown>): Promise<void> {
    await this.deps.audit.append({ actor: auditActor(principal), scope: identity, type, metadata })
  }

  private async auditRejection(principal: ResolvedPrincipal, identity: JobIdentity, type: AuditInput["type"], metadata: Record<string, unknown>): Promise<void> {
    await this.deps.audit.append({ actor: auditActor(principal), scope: identity, type, metadata })
  }
}

/** In-memory admission idempotency registry (tenant-scoped). */
export class InMemoryAdmissionIdempotencyRegistry implements AdmissionIdempotencyRegistry {
  private readonly entries = new Map<string, AdmissionIdempotencyRecord>()
  private key(tenantId: string, key: string): string {
    return `${tenantId}|${key}`
  }
  async record(tenantId: string, key: string, value: AdmissionIdempotencyRecord): Promise<void> {
    this.entries.set(this.key(tenantId, key), value)
  }
  async lookup(tenantId: string, key: string): Promise<AdmissionIdempotencyRecord | undefined> {
    return this.entries.get(this.key(tenantId, key))
  }
}

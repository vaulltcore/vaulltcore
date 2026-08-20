/**
 * Audit contracts (Phase 1E).
 *
 * The audit log is append-only and durable. Records carry immutable actor
 * identity, tenant/org/project scope where applicable, event type, timestamp,
 * and sanitized metadata. Plaintext secrets, API keys, and credentials NEVER
 * appear in audit data — {@link sanitizeMetadata} strips them before any write.
 */

export const AUDIT_EVENT_TYPES = [
  "tenant_created",
  "org_created",
  "project_created",
  "member_added",
  "member_role_changed",
  "member_removed",
  "apikey_created",
  "apikey_revoked",
  "policy_created",
  "policy_changed",
  "quota_reserved",
  "quota_rejected",
  "quota_released",
  "quota_settled",
  "job_admitted",
  "job_rejected",
  "job_started",
  "job_suspended",
  "job_resumed",
  "job_cancelled",
  "job_completed",
  "job_failed",
  "ownership_recovered",
  "policy_decision",
  "ledger_entry",
  // Phase 2A: automation product-layer actions. Additive — the audit store
  // persists `type` as TEXT, so no schema change is required. These let the
  // product layer audit template/version/run/approval/delivery actions through
  // the same append-only, sanitized audit log (no second audit model).
  "automation_template_created",
  "automation_template_archived",
  "automation_version_published",
  "automation_run_created",
  "automation_run_cancelled",
  "automation_run_failed",
  "automation_run_completed",
  "automation_approval_requested",
  "automation_approval_approved",
  "automation_approval_rejected",
  "automation_delivery_completed",
] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/** Immutable actor identity recorded on every audit event. */
export interface AuditActor {
  readonly principalId: string
  readonly kind: string
  readonly tenantId: string
}

export interface AuditEvent {
  readonly eventId: string
  readonly actor: AuditActor | null
  readonly tenantId: string | null
  readonly orgId: string | null
  readonly projectId: string | null
  readonly type: AuditEventType
  readonly timestamp: number
  /** Sanitized metadata; secrets already stripped. */
  readonly metadata: Readonly<Record<string, unknown>>
}

export interface AuditInput {
  readonly actor?: AuditActor | null
  readonly scope?: { tenantId?: string; orgId?: string; projectId?: string } | null
  readonly type: AuditEventType
  readonly metadata?: Record<string, unknown>
}

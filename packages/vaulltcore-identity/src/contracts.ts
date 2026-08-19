/**
 * Vaulltcore identity & organization model (Phase 1E).
 *
 * Durable B2B entities that scope every job: Tenant → Organization → Project,
 * with members holding roles and API keys / service accounts for non-human
 * principals. These types are persistence-agnostic; {@link SqlIdentityStore}
 * implements them behind the same SQL/dialect seam as the job store.
 *
 * Authorization is organization/project scoped: a principal resolves to a
 * (tenantId, orgId, role) plus an optional set of project grants. A job's
 * tenantId/orgId/projectId are immutable once created (the runner already
 * freezes them in {@link JobRecord}); the identity layer cross-validates them
 * at creation and recovery so no job can ever run under another tenant's scope.
 */

/** Minimum role set. `service_account` is reserved for non-human principals. */
export const ROLES = ["owner", "admin", "developer", "operator", "viewer", "service_account"] as const
export type Role = (typeof ROLES)[number]

/** Roles a service account may hold. */
export const SERVICE_ACCOUNT_ROLES: ReadonlySet<Role> = new Set(["operator", "viewer", "service_account"])

/** Roles that can manage members, API keys and projects. */
export const ADMIN_ROLES: ReadonlySet<Role> = new Set(["owner", "admin"])

/** Role rank for permission comparison (higher = more authority). */
export const ROLE_RANK: Record<Role, number> = {
  owner: 50,
  admin: 40,
  developer: 30,
  operator: 20,
  viewer: 10,
  service_account: 5,
}

export function hasAdminRights(role: Role): boolean {
  return ADMIN_ROLES.has(role)
}

export interface Tenant {
  readonly tenantId: string
  readonly createdAt: number
  readonly createdBy: string | null
  readonly displayName: string | null
}

export interface Organization {
  readonly orgId: string
  readonly tenantId: string
  readonly createdAt: number
  readonly displayName: string | null
}

export interface OrganizationMember {
  readonly tenantId: string
  readonly orgId: string
  readonly principalId: string
  readonly role: Role
  readonly createdAt: number
}

/** Optional per-project grant narrowing a member's access. */
export interface ProjectGrant {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly principalId: string
  readonly role: Role
}

export interface Project {
  readonly projectId: string
  readonly tenantId: string
  readonly orgId: string
  readonly createdAt: number
  readonly displayName: string | null
}

/** Principal kind backing an authenticated actor. */
export type PrincipalKind = "user" | "service_account"

/**
 * Authenticated principal: the resolved identity the control plane uses to
 * authorize job admission. `tenantId` is immutable authority; `orgId`/project
 * grants are authorization scope. Never reconstructed from a request body.
 */
export interface ResolvedPrincipal {
  readonly principalId: string
  readonly kind: PrincipalKind
  readonly tenantId: string
  readonly orgId: string
  readonly role: Role
  /** Projects the principal may act on; "*" = all projects in the org. */
  readonly projectScope: readonly string[]
  /** True only for cross-tenant operators (deny by default). */
  readonly admin?: boolean
}

/**
 * A verifiable API key. The plaintext secret is shown ONCE at creation
 * (`secret`) and never stored. Only `secretHash` (one-way) + a lookup
 * `keyPrefix`/`keyId` are durable, so a leaked database cannot mint requests.
 */
export interface ApiKeyRecord {
  readonly keyId: string
  readonly tenantId: string
  readonly orgId: string
  readonly principalId: string
  readonly name: string
  /** Public-ish prefix used for lookup, e.g. "vc_live_ab12…". */
  readonly keyPrefix: string
  /** One-way verifier (scrypt/sha256) of the full secret. */
  readonly secretHash: string
  readonly createdAt: number
  readonly revokedAt: number | null
  readonly lastUsedAt: number | null
}

/** Returned once when an API key is created. The secret is never recoverable. */
export interface CreatedApiKey extends ApiKeyRecord {
  /** Full secret, shown only this once. Format: prefix + secretBody. */
  readonly secret: string
}

/** Error surface for the identity layer. */
export class IdentityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "IdentityError"
  }
}

export const ROLE_REQUIRED = (role: Role): IdentityError => new IdentityError("FORBIDDEN_ROLE", `role "${role}" or higher is required`)

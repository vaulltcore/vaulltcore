/**
 * Vaulltcore credential & connection lifecycle contracts (Phase 2C).
 *
 * A "connection" is a tenant/org/project-scoped link to an external system
 * (GitHub, GitLab, Linear, Slack, an S3 endpoint, an SMTP server, a BYOK model
 * provider). A connection owns durable metadata (provider, account identity,
 * capabilities, last-used, expiry) and a reference to a secret held behind a
 * replaceable {@link SecretProvider} seam. The plaintext secret is NEVER
 * stored by the credential store, NEVER returned by list/get, NEVER written to
 * audit/logs/events/errors.
 *
 * Security invariants:
 * - Secrets flow only through explicit {@link CredentialResolver} boundaries.
 * - A connection's tenantId/orgId/projectId are immutable; a forged request
 *   body cannot select another tenant's connection.
 * - Rotation changes the secret reference without changing connection identity.
 * - Revocation/expiry is enforced at resolve time (a revoked/expired
 *   connection resolves to nothing).
 * - lastUsedAt is best-effort and NEVER an authorization source (authoritative
 *   key state, not a cached timestamp, gates access).
 */

/** Provider families a connection can target. */
export const PROVIDER_FAMILIES = [
  "git",
  "project",
  "notification",
  "storage",
  "email",
  "model",
] as const
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number]

/** Lifecycle state of a connection. */
export const CONNECTION_STATES = [
  "active",
  "revoked",
  "expired",
  "disconnected",
] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

/** A capability a connection declares it can perform (read, write, …). */
export type ConnectionCapability =
  | "read"
  | "write"
  | "repo:list"
  | "repo:read"
  | "repo:write"
  | "issue:read"
  | "issue:write"
  | "pr:read"
  | "pr:write"
  | "webhook:verify"
  | "model:stream"
  | "object:read"
  | "object:write"
  | "message:send"

/** The externally authenticated account a connection represents. */
export interface ProviderAccountIdentity {
  /** Stable external account/installation id (e.g. GitHub App installation id, Slack team id). */
  readonly externalId: string
  /** Human-readable account name (e.g. login, workspace name). Redacted-safe. */
  readonly displayName: string | null
  /** Scopes/permissions granted by the external provider. */
  readonly scopes: readonly string[]
}

/**
 * A resolved, usable credential handed to an adapter through the resolver.
 * The `secretRef` is opaque to callers — only the configured SecretProvider
 * can dereference it. Adapters never persist or log the dereferenced secret.
 */
export interface ResolvedCredential {
  readonly connectionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: ProviderFamily
  readonly provider: string
  /** Opaque reference the SecretProvider dereferences into a secret value. */
  readonly secretRef: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  /** SHA-256 fingerprint of the secret for dedup/rotation identity (never the secret). */
  readonly secretFingerprint: string
  /** Transient usable secret value; NEVER persisted/logged/audited/serialized.
   *  Crosses the resolver→adapter boundary only, for the duration of one call. */
  readonly secret: string
}

/**
 * Durable connection metadata. The plaintext secret is NEVER in this record.
 * `secretRef` is an opaque pointer the SecretProvider resolves; `secretFingerprint`
 * is a one-way hash used to detect rotation/identity without storing the secret.
 */
export interface ProviderConnection {
  readonly connectionId: string
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: ProviderFamily
  /** Concrete provider within the family (e.g. "github-com", "gitlab-com", "openai"). */
  readonly provider: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  readonly state: ConnectionState
  /** Opaque secret reference; never dereferenced by the store. */
  readonly secretRef: string
  /** SHA-256 fingerprint of the secret body (never the secret). */
  readonly secretFingerprint: string
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastUsedAt: number | null
  /** Absolute expiry (ms epoch); null = no expiry. Enforced at resolve time. */
  readonly expiresAt: number | null
  /** connectionId this connection was rotated from (rotation keeps identity stable via version). */
  readonly rotatedFrom: string | null
}

/** Input to create a connection. The secret is supplied through the
 *  SecretProvider which returns the opaque ref + fingerprint; the store never
 *  receives the plaintext. */
export interface CreateConnectionInput {
  readonly tenantId: string
  readonly orgId: string
  readonly projectId: string
  readonly family: ProviderFamily
  readonly provider: string
  readonly account: ProviderAccountIdentity
  readonly capabilities: readonly ConnectionCapability[]
  /** Opaque secret reference returned by SecretProvider.store. */
  readonly secretRef: string
  /** SHA-256 fingerprint returned by SecretProvider.store. */
  readonly secretFingerprint: string
  readonly expiresAt?: number | null
}

/** Error surface for the credential layer. */
export class CredentialError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = "CredentialError"
  }
}

/**
 * Vaulltcore Credentials & Connection Lifecycle (Phase 2C).
 *
 * Durable, tenant-scoped credential/connection model behind a replaceable
 * SecretProvider seam. The plaintext secret NEVER persists in the credential
 * store, NEVER appears in API responses/logs/audit/events/errors. Rotation
 * changes the secret without changing connection identity. Revocation/expiry
 * is enforced authoritatively at resolve time.
 *
 * Dependency direction: credentials → {store-sql, audit}. It never depends on
 * the runner, a provider SDK, or the control plane. No vendor is a dependency.
 */

export {
  PROVIDER_FAMILIES,
  CONNECTION_STATES,
  type ProviderFamily,
  type ConnectionState,
  type ConnectionCapability,
  type ProviderAccountIdentity,
  type ResolvedCredential,
  type ProviderConnection,
  type CreateConnectionInput,
  CredentialError,
} from "./contracts"
export {
  SqlCredentialStore,
  CREDENTIAL_MIGRATIONS,
  type CredentialStoreOptions,
  type ConnectionPublicView,
  toPublicView,
} from "./store"
export {
  CredentialResolver,
  type CredentialResolverOptions,
} from "./resolver"
export {
  type SecretProvider,
  type StoredSecret,
  secretFingerprint,
  InMemorySecretProvider,
  EnvSecretProvider,
} from "./secret-provider"

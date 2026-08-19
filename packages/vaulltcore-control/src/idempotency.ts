/**
 * Idempotency registry for POST /jobs (Phase 1C). Repeating a POST with the
 * same authenticated identity and the same `Idempotency-Key` returns the same
 * logical job instead of creating duplicate work.
 *
 * The registry is deliberately injectable: the in-memory map below is the
 * test/local default; production wiring should back it by the SQL store (the
 * key lands in a unique `idempotency_keys` table). Either way the correctness
 * property — same key, same job — is enforced here once, outside the routes.
 */

export interface IdempotencyRegistry {
  record(tenantId: string, key: string, jobId: string): Promise<void>
  lookup(tenantId: string, key: string): Promise<string | undefined>
  delete(tenantId: string, key: string): Promise<void>
}

export class InMemoryIdempotencyRegistry implements IdempotencyRegistry {
  private readonly entries = new Map<string, string>()
  private composite(tenantId: string, key: string): string {
    return `${tenantId}${key}`
  }
  async record(tenantId: string, key: string, jobId: string): Promise<void> {
    this.entries.set(this.composite(tenantId, key), jobId)
  }
  async lookup(tenantId: string, key: string): Promise<string | undefined> {
    return this.entries.get(this.composite(tenantId, key))
  }
  async delete(tenantId: string, key: string): Promise<void> {
    this.entries.delete(this.composite(tenantId, key))
  }
}

/**
 * PostgreSQL migration applier (Phase 1D).
 *
 * The migration statements in {@link MIGRATIONS} are written in a portable
 * subset of SQL. PostgreSQL needs `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX
 * IF NOT EXISTS` idempotence (re-running on an existing schema is a no-op) and
 * a SERIAL-friendly ledger. Statements are otherwise unchanged from SQLite so
 * the schema is identical across both backends.
 */

import type { Pool } from "pg"
import { MIGRATIONS } from "./migrations"

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at BIGINT NOT NULL
)`

/** Portably idempotent: re-runnable on PostgreSQL without errors. */
function idempotent(stmt: string): string {
  if (/^CREATE TABLE/i.test(stmt.trim())) return stmt.replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS")
  if (/^CREATE INDEX/i.test(stmt.trim())) return stmt.replace(/^CREATE INDEX/i, "CREATE INDEX IF NOT EXISTS")
  return stmt
}

/** Apply pending migrations to a PostgreSQL pool. Returns applied versions. */
export async function applyMigrationsPg(pool: Pool): Promise<number[]> {
  await pool.query(LEDGER)
  const { rows } = await pool.query("SELECT version FROM schema_migrations")
  const applied = new Set(rows.map((r) => Number(r.version)))
  const newlyApplied: number[] = []
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      try {
        for (const statement of migration.statements) await client.query(idempotent(statement))
        await client.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1,$2,$3)", [
          migration.version,
          migration.name,
          Date.now(),
        ])
        await client.query("COMMIT")
        newlyApplied.push(migration.version)
      } catch (error) {
        try {
          await client.query("ROLLBACK")
        } catch {
          // already rolled back
        }
        throw error
      }
    } finally {
      client.release()
    }
  }
  return newlyApplied
}

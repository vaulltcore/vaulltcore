/**
 * Versioned schema migrations for the SQL job store.
 *
 * Applied in order inside a single transaction per migration; each applied
 * version is recorded in `schema_migrations`. Statements are written in a
 * portable subset of SQL (FFI-safe for the SQLite reference driver; Postgres
 * needs only type tweaks — TEXT/INTEGER carry over).
 *
 * Invariants enforced by the schema itself:
 * - `job_events` PRIMARY KEY (job_id, seq): duplicate delivery is
 *   deterministically rejected by the database, never silently absorbed.
 * - `job_leases` PRIMARY KEY (job_id): at most one live lease row per job —
 *   exactly one authoritative active owner.
 * - `job_checkpoints` PRIMARY KEY (job_id): exactly one authoritative
 *   checkpoint per job; the watermark inside it defines committed history.
 * - Ownership generation (`jobs.attempt`) is a plain column; the store only
 *   ever increments it inside the lease-acquisition transaction, with the
 *   conditional-UPDATE CAS as a second layer under contention.
 */

import type { SqlDatabase } from "./driver"

export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core_job_tables",
    statements: [
      `CREATE TABLE jobs (
        job_id           TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL,
        org_id           TEXT NOT NULL,
        project_id       TEXT NOT NULL,
        status           TEXT NOT NULL,
        attempt          INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        spec             TEXT NOT NULL,
        env              TEXT NOT NULL,
        policy           TEXT NOT NULL,
        latest_snapshot  TEXT,
        last_seq         INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      )`,
      `CREATE INDEX jobs_tenant_idx ON jobs (tenant_id, org_id, project_id)`,
      `CREATE TABLE job_leases (
        job_id      TEXT PRIMARY KEY REFERENCES jobs (job_id) ON DELETE CASCADE,
        token       TEXT NOT NULL,
        generation  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL
      )`,
      `CREATE TABLE job_events (
        job_id    TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type      TEXT NOT NULL,
        data      TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      )`,
      `CREATE TABLE job_checkpoints (
        job_id         TEXT PRIMARY KEY REFERENCES jobs (job_id) ON DELETE CASCADE,
        checkpoint     TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL,
        attempt        INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      )`,
      `CREATE TABLE job_snapshots (
        job_id      TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL,
        snapshot    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (job_id, snapshot_id)
      )`,
    ],
  },
]

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`

/** Apply pending migrations in version order. Returns applied versions.
 *
 * The migration ledger (`schema_migrations`) is shared across all stores that
 * wrap the same {@link SqlDatabase}: version numbers are globally unique, so a
 * business-layer store may pass its own migration list (Phase 1E) and already
 * applied versions are skipped. This lets durable business state share the
 * execution store's database without duplicating the migration machinery. */
export function applyMigrations(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec(LEDGER)
  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all()
  const applied = new Set(appliedRows.map((row) => Number(row.version)))
  const newlyApplied: number[] = []
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    db.exec("BEGIN")
    try {
      for (const statement of migration.statements) db.exec(statement)
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      )
      db.exec("COMMIT")
      newlyApplied.push(migration.version)
    } catch (error) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // already rolled back
      }
      throw error
    }
  }
  return newlyApplied
}

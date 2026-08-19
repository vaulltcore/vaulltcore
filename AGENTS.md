# Vaulltcore repo memory

- Monorepo: npm workspaces; packages export `src/index.ts` directly (no build step; vitest
  resolves TS). `npm test` = vitest, `npm run typecheck` = `tsc --build packages/*`.
- Phase 1A delivered a durable job runner; full report in `docs/phase1a.md`.
- Hard seam: `packages/vaulltcore-runner` (neutral, zero runtime deps) must never import
  from `packages/vaulltcore-runner-opencode` (adapter). Engine-specific types must not
  leak into the neutral contracts.
- Durability rules that must not regress: tool calls recorded before execution; commit
  boundary = `checkpoint` event + checksummed checkpoint file; resume validates checksum,
  identity, policy/engine versions, watermark before continuing; recorded-but-unsettled
  tool calls are never blindly re-executed.
- Deterministic engines (`ScriptEngine`, `ScriptModelProvider`) derive their step index
  from committed history (assistant message count), not instance state — fresh instances
  must resume correctly.
- Extracted OpenCode code is MIT; keep attribution headers and `NOTICE.md` current.

Phase 1C COMPLETE: 76/76 tests, report docs/phase1c.md.
- New packages: `packages/vaulltcore-store-sql` (transactional DurableJobStore over node:sqlite via SqlDatabase/SqlDialect seam -- Postgres-ready), `packages/vaulltcore-environment-cloud` (vendor-neutral CloudExecutionProvider + CloudExecutionEnvironment + FakeCloudProvider), `packages/vaulltcore-control` (thin HTTP facade over AgentRunner: POST/GET /jobs, SSE events, cancel, input, usage; replaceable auth boundary; Idempotency-Key registry).
- Runner contract additions (backward compatible): `getJob`, `listEvents`; `JobView` read model; `snapshot-policy.ts` (SnapshotPolicy/ThresholdSnapshotPolicy; advisory only, emits sanitized "snapshot_decision" warning events).
- Invariants that must not regress: SQL store keeps fenced CAS on every state-changing write; (job_id, seq) PRIMARY KEY rejects duplicate delivery; orphan events beyond checkpoint watermark never replay as committed history; cloud snapshot is optimization only -- checkpoint + event log stay authoritative; capability honesty: unsupported native ops throw CapabilityUnsupportedError, never pretend; control plane derives tenant from the authenticated principal, never from request body; snapshot policy can never suppress checkpoint durability.
- node:sqlite is experimental in Node 22: it is loaded via createRequire in store-sql/src/driver.ts so bundlers (vite/vitest) do not try to resolve the stripped "sqlite" id. Do not replace with a static import.
- Test loop gotcha: the runner loop only continues past a turn when the turn emitted tool calls; a text-only turn is terminal. Tests that need multi-turn jobs must give turn 0 a tool call.

Phase 1B COMPLETE (AX extraction): contracts extended in packages/vaulltcore-runner/src/contracts.ts (SuspensionReason, WorkspaceState, ExecutionSnapshot, ExecutionEnvironment, OwnershipGrant, ActorHandle, RecoveryContext, ExecutionActorController, JobRecord.latestSnapshot). environment.ts (LocalExecutionEnvironment: sha256(jobId) binding, manifest+per-file hash snapshots, same-host reattach). actor.ts (ExecutionActorControllerImpl: acquire/start/suspend/recover/resume/snapshot/release/destroy; recovery algorithm: validate→fence→checkpoint→events→workspace→snapshot→proceed; invalid continuation parks suspended). Store fenced appends (expectedAttempt) + releaseLease. Runner routes through controller. Tests 34/34; report docs/phase1b-actors.md.

Phase 1C COMPLETE: 76/76 tests, report docs/phase1c.md.
- New packages: `packages/vaulltcore-store-sql` (transactional DurableJobStore over node:sqlite via SqlDatabase/SqlDialect seam — Postgres-ready), `packages/vaulltcore-environment-cloud` (vendor-neutral CloudExecutionProvider + CloudExecutionEnvironment + FakeCloudProvider), `packages/vaulltcore-control` (thin HTTP facade over AgentRunner: POST/GET /jobs, SSE events, cancel, input, usage; replaceable auth boundary; Idempotency-Key registry).
- Runner contract additions (backward compatible): `getJob`, `listEvents`; `JobView` read model; `snapshot-policy.ts` (SnapshotPolicy/ThresholdSnapshotPolicy; advisory only, emits sanitized "snapshot_decision" warning events).
- Invariants that must not regress: SQL store keeps fenced CAS on every state-changing write; (job_id, seq) PRIMARY KEY rejects duplicate delivery; orphan events beyond checkpoint watermark never replay as committed history; cloud snapshot is optimization only — checkpoint + event log stay authoritative; capability honesty: unsupported native ops throw CapabilityUnsupportedError, never pretend; control plane derives tenant from the authenticated principal, never from request body; snapshot policy can never suppress checkpoint durability.
- node:sqlite is experimental in Node 22: it is loaded via createRequire in store-sql/src/driver.ts so bundlers (vite/vitest) do not try to resolve the stripped "sqlite" id. Do not replace with a static import.
- Test loop gotcha: the runner loop only continues past a turn when the turn emitted tool calls; a text-only turn is terminal. Tests that need multi-turn jobs must give turn 0 a tool call.

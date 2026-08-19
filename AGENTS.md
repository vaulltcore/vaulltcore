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

Phase 1B COMPLETE (AX extraction): contracts extended in packages/vaulltcore-runner/src/contracts.ts (SuspensionReason, WorkspaceState, ExecutionSnapshot, ExecutionEnvironment, OwnershipGrant, ActorHandle, RecoveryContext, ExecutionActorController, JobRecord.latestSnapshot). environment.ts (LocalExecutionEnvironment: sha256(jobId) binding, manifest+per-file hash snapshots, same-host reattach). actor.ts (ExecutionActorControllerImpl: acquire/start/suspend/recover/resume/snapshot/release/destroy; recovery algorithm: validate→fence→checkpoint→events→workspace→snapshot→proceed; invalid continuation parks suspended). Store fenced appends (expectedAttempt) + releaseLease. Runner routes through controller. Tests 34/34; report docs/phase1b-actors.md.

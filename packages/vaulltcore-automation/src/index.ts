/**
 * Vaulltcore Automation Product Layer (Phase 2A).
 *
 * The customer-facing automation product above the Phase 1 execution kernel:
 * templates → immutable versions → runs → jobs → artifacts → approvals → delivery.
 *
 * Dependency direction (enforced, never inverted):
 *   identity / policy
 *     ↓
 *   automation product layer  (this package)
 *     ↓
 *   control-plane integration (vaulltcore-control)
 *     ↓
 *   Phase 1 runner contracts (vaulltcore-runner)
 *     ↓
 *   environment / agent engine
 *
 * The runner never imports this package. The product layer consumes the Phase 1
 * runner/control contracts through the narrow {@link AutomationJobDispatcher}
 * seam; it never depends on runner internals, OpenCode, AX, Docker,
 * PostgreSQL, or any cloud vendor.
 */

export * from "./contracts"
export * from "./ids"
export * from "./version"
export * from "./input"
export * from "./run"
export * from "./artifact"
export * from "./approval"
export * from "./delivery"
export {
  type AutomationStore,
  type AutomationStoreOptions,
  SqlAutomationStore,
  AUTOMATION_MIGRATIONS,
} from "./store"
export { InMemoryAutomationStore } from "./store-memory"
export { projectStepEvents, stepStatusFromJobStatus, automationEvent } from "./projection"
export {
  AutomationService,
  type AutomationServiceDeps,
  type AutomationJobDispatcher,
  type DispatchStepRequest,
  type DispatchStepResult,
  approverRoleRank,
} from "./service"

/**
 * Metering adapter: project durable runner events into idempotent usage events.
 *
 * The runner's {@link JobMetrics} and `usage`/`tool_response`/`message`
 * {@link JobEvent}s feed the metering layer through this explicit seam, so the
 * runner stays replaceable and neutral. Dedup keys are derived from the
 * durable event seq (monotonic and unique per job), so a worker crash/retry
 * that re-runs this adapter over the same committed events produces the SAME
 * dedup keys and the metering store records each fact exactly once.
 *
 * Preserves the at-least-once-execution / exactly-once-metering guarantee: the
 * runner may replay events, but the (jobId, kind, dedupKey) UNIQUE constraint
 * collapses duplicates at the durable identity boundary.
 */

import type { JobEvent, JobIdentity, JobMetrics } from "@vaulltcore/runner"
import type { UsageEventInput } from "./contracts"

/** Identity augmented with the job id (the runner's JobIdentity has no jobId). */
export interface MeteringIdentity extends JobIdentity {
  readonly jobId: string
}

/**
 * Convert a batch of durable runner events into usage events. Only committed
 * events up to the checkpoint watermark should be passed (the runner exposes
 * `listEvents`; the control plane filters by watermark when needed). Each
 * produced {@link UsageEventInput} carries a seq-derived dedup key.
 */
export function eventsToUsage(identity: MeteringIdentity, events: readonly JobEvent[]): UsageEventInput[] {
  const out: UsageEventInput[] = []
  for (const event of events) {
    switch (event.type) {
      case "usage": {
        const data = event.data as {
          stepIndex?: number
          inputTokens?: number
          outputTokens?: number
          reasoningTokens?: number
        }
        if (typeof data.inputTokens === "number" && data.inputTokens > 0) {
          out.push(tokenEvent(identity, event.seq, "input", data.inputTokens))
        }
        if (typeof data.outputTokens === "number" && data.outputTokens > 0) {
          out.push(tokenEvent(identity, event.seq, "output", data.outputTokens))
        }
        if (typeof data.reasoningTokens === "number" && data.reasoningTokens > 0) {
          out.push(tokenEvent(identity, event.seq, "reasoning", data.reasoningTokens))
        }
        // One model request per usage event = one step.
        out.push({
          identity,
          kind: "model_request",
          quantity: 1,
          dedupKey: `step:${event.seq}`,
          unit: "request",
        })
        break
      }
      case "tool_response": {
        out.push({
          identity,
          kind: "tool_call",
          quantity: 1,
          dedupKey: `tool:${event.seq}`,
          unit: "call",
        })
        break
      }
      default:
        break
    }
  }
  return out
}

function tokenEvent(identity: MeteringIdentity, seq: number, bucket: string, quantity: number): UsageEventInput {
  return {
    identity,
    kind: "model_tokens",
    quantity,
    dedupKey: `tokens:${seq}:${bucket}`,
    unit: "tokens",
  }
}

/**
 * Emit a single execution-duration usage event for a job. Callers derive the
 * duration from the job's start/completion timestamps; the dedup key is the
 * job id so re-deriving duration on recovery records it exactly once.
 */
export function durationUsage(identity: MeteringIdentity, durationMs: number): UsageEventInput {
  return {
    identity,
    kind: "execution_duration",
    quantity: durationMs,
    dedupKey: `duration:${identity.jobId}`,
    unit: "ms",
  }
}

/** Snapshot/storage usage (idempotent per snapshot id). */
export function snapshotUsage(identity: MeteringIdentity, snapshotId: string, bytes: number): UsageEventInput {
  return {
    identity,
    kind: "snapshot_storage",
    quantity: bytes,
    dedupKey: `snapshot:${snapshotId}`,
    unit: "bytes",
  }
}

/** Convert the runner's JobMetrics into a one-shot usage batch (idempotent by
 *  job id; useful when only the final metrics are available). */
export function metricsToUsage(identity: MeteringIdentity, metrics: JobMetrics): UsageEventInput[] {
  return [
    { identity, kind: "model_tokens", quantity: metrics.inputTokens, dedupKey: "metrics:input", unit: "tokens" },
    { identity, kind: "model_tokens", quantity: metrics.outputTokens, dedupKey: "metrics:output", unit: "tokens" },
    { identity, kind: "model_tokens", quantity: metrics.reasoningTokens, dedupKey: "metrics:reasoning", unit: "tokens" },
    { identity, kind: "model_request", quantity: metrics.steps, dedupKey: "metrics:steps", unit: "request" },
    { identity, kind: "tool_call", quantity: metrics.toolCalls, dedupKey: "metrics:toolCalls", unit: "call" },
  ]
}

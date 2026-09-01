import { apiRequest } from "./client";
import type {
  RetryStatusItem,
  DeadLetterItem,
  HealthReport,
  ReliabilityHealthReport,
  ReadinessReport,
  ReconciliationResult,
  TimeoutScanResult,
} from "@/types";

export const operationsApi = {
  retryStatusUrl() { return "/operations/retry-status"; },
  healthP2bUrl() { return "/operations/health/p2b"; },
  healthReliabilityUrl() { return "/operations/health/reliability"; },
  deadLetterUrl() { return "/operations/dead-letter"; },
  redriveUrl(id: string) { return `/operations/dead-letter/${id}/redrive`; },
  redriveDispatchUrl(id: string) { return `/operations/dispatches/${id}/redrive`; },
  reconcileUrl() { return "/operations/reconcile"; },
  timeoutScanUrl() { return "/operations/timeout-scan"; },
  readinessUrl() { return "/readiness"; },
  metricsUrl() { return "/automation/metrics"; },

  async retryStatus(opts?: { kind?: string; state?: string }, signal?: AbortSignal) {
    return apiRequest<{ items: RetryStatusItem[] }>("/operations/retry-status", {
      params: opts as Record<string, string | number | undefined>,
      signal,
    });
  },

  async healthP2b(signal?: AbortSignal) {
    return apiRequest<HealthReport>("/operations/health/p2b", { signal });
  },

  async healthReliability(signal?: AbortSignal) {
    return apiRequest<ReliabilityHealthReport>("/operations/health/reliability", { signal });
  },

  async deadLetter(signal?: AbortSignal) {
    return apiRequest<{
      items: RetryStatusItem[];
      deadLetter: DeadLetterItem[];
      dispatchDeadLetter: DeadLetterItem[];
    }>("/operations/dead-letter", { signal });
  },

  async redrive(id: string, signal?: AbortSignal) {
    return apiRequest<unknown>(`/operations/dead-letter/${id}/redrive`, { method: "POST", signal });
  },

  async redriveDispatch(id: string, signal?: AbortSignal) {
    return apiRequest<unknown>(`/operations/dispatches/${id}/redrive`, { method: "POST", signal });
  },

  async reconcile(all?: boolean, signal?: AbortSignal) {
    return apiRequest<ReconciliationResult>("/operations/reconcile", {
      method: "POST",
      body: all ? { all: true } : {},
      signal,
    });
  },

  async timeoutScan(signal?: AbortSignal) {
    return apiRequest<TimeoutScanResult>("/operations/timeout-scan", { method: "POST", signal });
  },

  async readiness(signal?: AbortSignal) {
    return apiRequest<ReadinessReport>("/readiness", { signal });
  },

  async metrics(opts?: { orgId?: string; projectId?: string }, signal?: AbortSignal) {
    return apiRequest<Record<string, unknown>>("/automation/metrics", {
      params: opts as Record<string, string | number | undefined>,
      signal,
    });
  },
};
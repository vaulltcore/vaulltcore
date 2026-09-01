import { apiRequest } from "./client";
import type { UsagePage, UsageAggregate, UsageSummary, CursorPagination } from "@/types";

export const usageApi = {
  listUrl() { return "/usage"; },
  summaryUrl() { return "/usage/summary"; },
  runUsageUrl(runId: string) { return `/usage/runs/${runId}`; },
  ledgerUrl() { return "/usage/ledger"; },

  async list(pagination: CursorPagination & {
    from?: number;
    to?: number;
    kind?: string;
    provider?: string;
    model?: string;
    runId?: string;
  }, signal?: AbortSignal) {
    return apiRequest<UsagePage>("/usage", {
      params: pagination as Record<string, string | number | undefined>,
      signal,
    });
  },

  async summary(opts?: { from?: number; to?: number; kind?: string; provider?: string; model?: string }, signal?: AbortSignal) {
    return apiRequest<UsageSummary>("/usage/summary", {
      params: opts as Record<string, string | number | undefined>,
      signal,
    });
  },

  async runUsage(runId: string, signal?: AbortSignal) {
    return apiRequest<UsageAggregate>(`/usage/runs/${runId}`, { signal });
  },

  async ledger(pagination: CursorPagination, signal?: AbortSignal) {
    return apiRequest<UsagePage>("/usage/ledger", {
      params: pagination as Record<string, string | number | undefined>,
      signal,
    });
  },
};
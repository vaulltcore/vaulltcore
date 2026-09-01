import { apiRequest } from "./client";
import type {
  AutomationTemplate,
  AutomationVersion,
  AutomationRun,
  AutomationEvent,
  AutomationArtifact,
  ApprovalRequest,
  SanitizedDelivery,
} from "@/types";
import { newIdempotencyKey } from "@/lib/idempotency";

export const automationApi = {
  templates: {
    listUrl() { return "/automation/templates"; },
    createUrl() { return "/automation/templates"; },
    versionsUrl(templateId: string) { return `/automation/templates/${templateId}/versions`; },
    createVersionUrl(templateId: string) { return `/automation/templates/${templateId}/versions`; },

    async list(opts?: { orgId?: string; projectId?: string }, signal?: AbortSignal) {
      return apiRequest<{ templates: AutomationTemplate[] }>(
        "/automation/templates",
        { params: opts as Record<string, string | number | undefined>, signal }
      );
    },

    async create(body: { name: string; description?: string; orgId?: string; projectId?: string }, signal?: AbortSignal) {
      return apiRequest<AutomationTemplate>("/automation/templates", { method: "POST", body, signal });
    },

    async versions(templateId: string, signal?: AbortSignal) {
      return apiRequest<{ versions: AutomationVersion[] }>(`/automation/templates/${templateId}/versions`, { signal });
    },

    async createVersion(
      templateId: string,
      body: { definition: AutomationVersion["definition"]; inputContract: AutomationVersion["inputContract"] },
      signal?: AbortSignal
    ) {
      return apiRequest<AutomationVersion>(`/automation/templates/${templateId}/versions`, {
        method: "POST",
        body,
        signal,
      });
    },
  },

  runs: {
    listUrl() { return "/automation/runs"; },
    getUrl(runId: string) { return `/automation/runs/${runId}`; },
    eventsUrl(runId: string, opts?: { after?: number }) {
      const params = new URLSearchParams();
      if (opts?.after !== undefined) params.set("after", String(opts.after));
      const q = params.toString();
      return `/automation/runs/${runId}/events${q ? `?${q}` : ""}`;
    },
    artifactsUrl(runId: string) { return `/automation/runs/${runId}/artifacts`; },
    deliveriesUrl(runId: string) { return `/automation/runs/${runId}/deliveries`; },
    advanceUrl(runId: string) { return `/automation/runs/${runId}/advance`; },
    cancelUrl(runId: string) { return `/automation/runs/${runId}/cancel`; },

    async create(body: {
      templateId: string;
      versionId: string;
      input: Record<string, unknown>[];
      orgId?: string;
      projectId?: string;
    }, signal?: AbortSignal) {
      const key = newIdempotencyKey("run-create");
      return apiRequest<AutomationRun>("/automation/runs", {
        method: "POST",
        body,
        idempotencyKey: key,
        signal,
      });
    },

    async get(runId: string, signal?: AbortSignal) {
      return apiRequest<AutomationRun>(`/automation/runs/${runId}`, { signal });
    },

    async events(runId: string, opts?: { after?: number }, signal?: AbortSignal) {
      return apiRequest<{ events: AutomationEvent[] }>(
        `/automation/runs/${runId}/events`,
        { params: opts as Record<string, string | number | undefined>, signal }
      );
    },

    async artifacts(runId: string, signal?: AbortSignal) {
      return apiRequest<{ artifacts: AutomationArtifact[] }>(`/automation/runs/${runId}/artifacts`, { signal });
    },

    async deliveries(runId: string, signal?: AbortSignal) {
      return apiRequest<{ deliveries: SanitizedDelivery[] }>(`/automation/runs/${runId}/deliveries`, { signal });
    },

    async advance(runId: string, signal?: AbortSignal) {
      return apiRequest<AutomationRun>(`/automation/runs/${runId}/advance`, { method: "POST", signal });
    },

    async cancel(runId: string, signal?: AbortSignal) {
      return apiRequest<AutomationRun>(`/automation/runs/${runId}/cancel`, { method: "POST", signal });
    },
  },

  approvals: {
    async approve(id: string, metadata?: Record<string, unknown>, signal?: AbortSignal) {
      return apiRequest<{ approval: ApprovalRequest; run: AutomationRun }>(
        `/automation/approvals/${id}/approve`,
        { method: "POST", body: { metadata }, signal }
      );
    },

    async reject(id: string, metadata?: Record<string, unknown>, signal?: AbortSignal) {
      return apiRequest<{ approval: ApprovalRequest; run: AutomationRun }>(
        `/automation/approvals/${id}/reject`,
        { method: "POST", body: { metadata }, signal }
      );
    },

    async requestChanges(id: string, metadata?: Record<string, unknown>, signal?: AbortSignal) {
      return apiRequest<{ approval: ApprovalRequest; run: AutomationRun }>(
        `/automation/approvals/${id}/changes`,
        { method: "POST", body: { metadata }, signal }
      );
    },
  },
};
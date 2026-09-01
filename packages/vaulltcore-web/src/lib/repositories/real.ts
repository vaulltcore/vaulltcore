// Real API repository implementations using the typed API client.
// Every method routes through `apiRequest()` so authentication headers,
// JSON encoding/decoding, error parsing, abort signals, and idempotency
// keys are owned by exactly one transport layer.

import { apiRequest } from "@/lib/api/client";
import { jobsApi } from "@/lib/api/jobs";
import { automationApi } from "@/lib/api/automation";
import { schedulesApi } from "@/lib/api/schedules";
import { connectionsApi } from "@/lib/api/connections";
import { triggersApi } from "@/lib/api/triggers";
import { usageApi } from "@/lib/api/usage";
import { operationsApi } from "@/lib/api/operations";
import type { AppRepositories } from "./interfaces";

export const realRepositories: AppRepositories = {
  jobs: {
    async list(opts) {
      return apiRequest<Awaited<ReturnType<typeof jobsApi.list>>>("/jobs", {
        params: opts as Record<string, string | number | undefined>,
      });
    },
    async get(jobId, signal) { return apiRequest(jobsApi.getUrl(jobId), { signal }); },
    async events(jobId, opts, signal) {
      return apiRequest(jobsApi.eventsUrl(jobId, opts), { signal });
    },
    async cancel(jobId, signal) { return apiRequest(jobsApi.cancelUrl(jobId), { method: "POST", signal }); },
    async input(jobId, text, signal) {
      return apiRequest(jobsApi.inputUrl(jobId), { method: "POST", body: { text }, signal });
    },
    async usage(jobId, signal) { return apiRequest(jobsApi.usageUrl(jobId), { signal }); },
  },

  automation: {
    templates: {
      async list(opts, signal) {
        return apiRequest<{ templates: Awaited<ReturnType<typeof automationApi.templates.list>>["templates"] }>(
          automationApi.templates.listUrl(),
          { params: opts as Record<string, string | number | undefined>, signal }
        );
      },
      async create(body, signal) { return apiRequest(automationApi.templates.createUrl(), { method: "POST", body, signal }); },
      async versions(templateId, signal) { return apiRequest(automationApi.templates.versionsUrl(templateId), { signal }); },
      async createVersion(templateId, body, signal) {
        return apiRequest(automationApi.templates.createVersionUrl(templateId), { method: "POST", body, signal });
      },
    },
    runs: {
      async list(opts, signal) {
        return apiRequest<unknown[]>(automationApi.runs.listUrl(), {
          params: opts as Record<string, string | number | undefined>,
          signal,
        });
      },
      async get(runId, signal) { return apiRequest(automationApi.runs.getUrl(runId), { signal }); },
      async events(runId, opts, signal) {
        return apiRequest(automationApi.runs.eventsUrl(runId, opts), { signal });
      },
      async artifacts(runId, signal) { return apiRequest(automationApi.runs.artifactsUrl(runId), { signal }); },
      async deliveries(runId, signal) { return apiRequest(automationApi.runs.deliveriesUrl(runId), { signal }); },
      async advance(runId, signal) { return apiRequest(automationApi.runs.advanceUrl(runId), { method: "POST", signal }); },
      async cancel(runId, signal) { return apiRequest(automationApi.runs.cancelUrl(runId), { method: "POST", signal }); },
    },
    approvals: {
      async approve(id, metadata, signal) {
        return apiRequest(`/automation/approvals/${id}/approve`, { method: "POST", body: { metadata }, signal });
      },
      async reject(id, metadata, signal) {
        return apiRequest(`/automation/approvals/${id}/reject`, { method: "POST", body: { metadata }, signal });
      },
      async requestChanges(id, metadata, signal) {
        return apiRequest(`/automation/approvals/${id}/changes`, { method: "POST", body: { metadata }, signal });
      },
    },
  },

  schedules: {
    async list(opts, signal) { return apiRequest(schedulesApi.listUrl(), { params: opts as Record<string, string | number | undefined>, signal }); },
    async get(scheduleId, signal) { return apiRequest(schedulesApi.getUrl(scheduleId), { signal }); },
    async create(body, signal) { return apiRequest(schedulesApi.createUrl(), { method: "POST", body, signal }); },
    async pause(scheduleId, signal) { return apiRequest(schedulesApi.pauseUrl(scheduleId), { method: "POST", signal }); },
    async resume(scheduleId, signal) { return apiRequest(schedulesApi.resumeUrl(scheduleId), { method: "POST", signal }); },
    async cancel(scheduleId, signal) { return apiRequest(schedulesApi.cancelUrl(scheduleId), { method: "POST", signal }); },
    async occurrences(scheduleId, signal) { return apiRequest(schedulesApi.occurrencesUrl(scheduleId), { signal }); },
  },

  connections: {
    async capabilities(_, signal) { return apiRequest(connectionsApi.capabilitiesUrl(), { signal }); },
    async list(opts, signal) {
      return apiRequest<{ connections: Awaited<ReturnType<typeof connectionsApi.list>>["connections"] }>(
        connectionsApi.listUrl(),
        { params: opts as Record<string, string | number | undefined>, signal }
      );
    },
    async get(connectionId, signal) { return apiRequest(connectionsApi.getUrl(connectionId), { signal }); },
    async create(body, signal) { return apiRequest(connectionsApi.createUrl(), { method: "POST", body, signal }); },
    async reconnect(connectionId, body, signal) {
      return apiRequest(connectionsApi.reconnectUrl(connectionId), { method: "POST", body, signal });
    },
    async refresh(connectionId, signal) {
      return apiRequest(connectionsApi.refreshUrl(connectionId), { method: "POST", signal });
    },
    async disconnect(connectionId, signal) {
      return apiRequest(connectionsApi.disconnectUrl(connectionId), { method: "POST", signal });
    },
  },

  triggers: {
    async list(_, signal) { return apiRequest(triggersApi.listUrl(), { signal }); },
    async get(triggerId, signal) { return apiRequest(triggersApi.getUrl(triggerId), { signal }); },
    async create(body, signal) { return apiRequest(triggersApi.createUrl(), { method: "POST", body, signal }); },
    async enable(triggerId, signal) { return apiRequest(triggersApi.enableUrl(triggerId), { method: "POST", signal }); },
    async disable(triggerId, signal) { return apiRequest(triggersApi.disableUrl(triggerId), { method: "POST", signal }); },
    async invoke(triggerId, signal) { return apiRequest(triggersApi.invokeUrl(triggerId), { method: "POST", signal }); },
    async dispatch(dispatchId, signal) { return apiRequest(triggersApi.getDispatchUrl(dispatchId), { signal }); },
  },

  usage: {
    async list(params, signal) {
      return apiRequest(usageApi.listUrl(), { params: params as Record<string, string | number | undefined>, signal });
    },
    async summary(params, signal) {
      return apiRequest(usageApi.summaryUrl(), { params: params as Record<string, string | number | undefined>, signal });
    },
    async run(runId, signal) { return apiRequest(usageApi.runUsageUrl(runId), { signal }); },
    async ledger(params, signal) {
      return apiRequest(usageApi.ledgerUrl(), { params: params as Record<string, string | number | undefined>, signal });
    },
  },

  operations: {
    async retryStatus(opts, signal) {
      return apiRequest(operationsApi.retryStatusUrl(), { params: opts as Record<string, string | number | undefined>, signal });
    },
    async health(_, signal) { return apiRequest(operationsApi.healthReliabilityUrl(), { signal }); },
    async deadLetter(_, signal) { return apiRequest(operationsApi.deadLetterUrl(), { signal }); },
    async redrive(id, signal) { return apiRequest(operationsApi.redriveUrl(id), { method: "POST", signal }); },
    async dispatchRedrive(id, signal) { return apiRequest(operationsApi.redriveDispatchUrl(id), { method: "POST", signal }); },
    async reconcile(_, signal) { return apiRequest(operationsApi.reconcileUrl(), { method: "POST", signal }); },
    async timeoutScan(_, signal) { return apiRequest(operationsApi.timeoutScanUrl(), { method: "POST", signal }); },
    async readiness(_, signal) { return apiRequest(operationsApi.readinessUrl(), { signal }); },
  },

  metrics: {
    async get(_, signal) {
      return apiRequest(operationsApi.metricsUrl(), { signal });
    },
  },
};
import { apiRequest } from "./client";
import type { TriggerView, TriggerDispatch } from "@/types";

export const triggersApi = {
  listUrl() { return "/triggers"; },
  getUrl(id: string) { return `/triggers/${id}`; },
  createUrl() { return "/triggers"; },
  enableUrl(id: string) { return `/triggers/${id}/enable`; },
  disableUrl(id: string) { return `/triggers/${id}/disable`; },
  invokeUrl(id: string) { return `/triggers/${id}/invoke`; },
  getDispatchUrl(id: string) { return `/triggers/dispatches/${id}`; },

  async list(signal?: AbortSignal) {
    return apiRequest<{ triggers: TriggerView[] }>("/triggers", { signal });
  },

  async get(triggerId: string, signal?: AbortSignal) {
    return apiRequest<TriggerView>(`/triggers/${triggerId}`, { signal });
  },

  async create(body: {
    templateId: string;
    versionId: string;
    name: string;
    triggerClass: string;
    criteria?: Record<string, unknown>;
    scheduleId?: string;
    inputMapping?: Record<string, unknown>;
    state?: string;
  }, signal?: AbortSignal) {
    return apiRequest<TriggerView>("/triggers", { method: "POST", body, signal });
  },

  async enable(triggerId: string, signal?: AbortSignal) {
    return apiRequest<TriggerView>(`/triggers/${triggerId}/enable`, { method: "POST", signal });
  },

  async disable(triggerId: string, signal?: AbortSignal) {
    return apiRequest<TriggerView>(`/triggers/${triggerId}/disable`, { method: "POST", signal });
  },

  async invoke(triggerId: string, signal?: AbortSignal) {
    return apiRequest<{ dispatches: TriggerDispatch[]; runIds: string[] }>(
      `/triggers/${triggerId}/invoke`,
      { method: "POST", signal }
    );
  },

  async getDispatch(dispatchId: string, signal?: AbortSignal) {
    return apiRequest<TriggerDispatch>(`/triggers/dispatches/${dispatchId}`, { signal });
  },
};
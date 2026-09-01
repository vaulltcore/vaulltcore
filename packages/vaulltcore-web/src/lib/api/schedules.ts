import { apiRequest } from "./client";
import type { ScheduleView, OccurrenceView } from "@/types";

export const schedulesApi = {
  listUrl() { return "/automation/schedules"; },
  getUrl(id: string) { return `/automation/schedules/${id}`; },
  createUrl() { return "/automation/schedules"; },
  pauseUrl(id: string) { return `/automation/schedules/${id}/pause`; },
  resumeUrl(id: string) { return `/automation/schedules/${id}/resume`; },
  cancelUrl(id: string) { return `/automation/schedules/${id}/cancel`; },
  occurrencesUrl(id: string) { return `/automation/schedules/${id}/occurrences`; },

  async list(opts?: { orgId?: string; projectId?: string }, signal?: AbortSignal) {
    return apiRequest<{ schedules: ScheduleView[] }>("/automation/schedules", {
      params: opts as Record<string, string | number | undefined>,
      signal,
    });
  },

  async get(scheduleId: string, signal?: AbortSignal) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}`, { signal });
  },

  async create(body: {
    name: string;
    automationVersionId: string;
    kind: "one_time" | "recurring";
    cron?: string;
    scheduledAt?: number;
    timezone?: string;
    missedRunPolicy?: string;
    maxCatchUp?: number;
    input?: Record<string, unknown>;
  }, signal?: AbortSignal) {
    return apiRequest<ScheduleView>("/automation/schedules", { method: "POST", body, signal });
  },

  async pause(scheduleId: string, signal?: AbortSignal) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}/pause`, { method: "POST", signal });
  },

  async resume(scheduleId: string, signal?: AbortSignal) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}/resume`, { method: "POST", signal });
  },

  async cancel(scheduleId: string, signal?: AbortSignal) {
    return apiRequest<ScheduleView>(`/automation/schedules/${scheduleId}/cancel`, { method: "POST", signal });
  },

  async occurrences(scheduleId: string, signal?: AbortSignal) {
    return apiRequest<{ occurrences: OccurrenceView[] }>(
      `/automation/schedules/${scheduleId}/occurrences`,
      { signal }
    );
  },
};
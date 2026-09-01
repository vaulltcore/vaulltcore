import { apiRequest } from "./client";
import type { JobView, JobEvent } from "@/types";
import { newIdempotencyKey } from "@/lib/idempotency";

// URL builders — used by the real repository so it can route everything
// through `apiRequest()` without duplicating transport logic.
export const jobsApi = {
  createUrl() { return "/jobs"; },
  getUrl(jobId: string) { return `/jobs/${jobId}`; },
  eventsUrl(jobId: string, opts?: { after?: number; follow?: boolean }) {
    const params = new URLSearchParams();
    if (opts?.after !== undefined) params.set("after", String(opts.after));
    if (opts?.follow) params.set("follow", "true");
    const q = params.toString();
    return `/jobs/${jobId}/events${q ? `?${q}` : ""}`;
  },
  cancelUrl(jobId: string) { return `/jobs/${jobId}/cancel`; },
  inputUrl(jobId: string) { return `/jobs/${jobId}/input`; },
  usageUrl(jobId: string) { return `/jobs/${jobId}/usage`; },

  async create(spec: {
    spec: Record<string, unknown>;
    engine: string;
    model: string;
    input: string;
    policy?: Record<string, unknown>;
    projectId?: string;
  }): Promise<{ id: string; reservationId?: string; status: string }> {
    const key = newIdempotencyKey("job-create");
    return apiRequest("/jobs", {
      method: "POST",
      body: spec,
      idempotencyKey: key,
    });
  },

  async get(jobId: string, signal?: AbortSignal): Promise<JobView> {
    return apiRequest(`/jobs/${jobId}`, { signal });
  },

  async events(
    jobId: string,
    opts?: { after?: number; follow?: boolean },
    signal?: AbortSignal
  ): Promise<JobEvent[]> {
    return apiRequest(jobsApi.eventsUrl(jobId, opts), { signal });
  },

  async cancel(jobId: string, signal?: AbortSignal): Promise<{ status: string }> {
    return apiRequest(`/jobs/${jobId}/cancel`, { method: "POST", signal });
  },

  async input(jobId: string, text: string, signal?: AbortSignal): Promise<{ status: string }> {
    return apiRequest(`/jobs/${jobId}/input`, { method: "POST", body: { text }, signal });
  },

  async usage(jobId: string, signal?: AbortSignal): Promise<{ jobId: string; usage: Record<string, number> }> {
    return apiRequest(`/jobs/${jobId}/usage`, { signal });
  },
};
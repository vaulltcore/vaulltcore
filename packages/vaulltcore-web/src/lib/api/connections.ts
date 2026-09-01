import { apiRequest } from "./client";
import type { ConnectionView, ConnectionCapability } from "@/types";

export const connectionsApi = {
  capabilitiesUrl() { return "/integrations/capabilities"; },
  listUrl() { return "/connections"; },
  getUrl(id: string) { return `/connections/${id}`; },
  createUrl() { return "/connections"; },
  reconnectUrl(id: string) { return `/connections/${id}/reconnect`; },
  refreshUrl(id: string) { return `/connections/${id}/refresh`; },
  disconnectUrl(id: string) { return `/connections/${id}/disconnect`; },

  async capabilities(signal?: AbortSignal) {
    return apiRequest<{ capabilities: ConnectionCapability[] }>("/integrations/capabilities", { signal });
  },

  async list(opts?: { family?: string }, signal?: AbortSignal) {
    return apiRequest<{ connections: ConnectionView[] }>("/connections", {
      params: opts as Record<string, string | number | undefined>,
      signal,
    });
  },

  async get(connectionId: string, signal?: AbortSignal) {
    return apiRequest<ConnectionView>(`/connections/${connectionId}`, { signal });
  },

  async create(body: {
    provider: string;
    redirectUri: string;
    method?: string;
    scopes?: string[];
    codeVerifier?: string;
  }, signal?: AbortSignal) {
    return apiRequest<{
      attemptId: string;
      state: string;
      authorizeUrl: string;
      codeChallenge: string;
    }>("/connections", { method: "POST", body, signal });
  },

  async reconnect(connectionId: string, body: { redirectUri: string }, signal?: AbortSignal) {
    return apiRequest<{
      attemptId: string;
      state: string;
      authorizeUrl: string;
    }>(`/connections/${connectionId}/reconnect`, { method: "POST", body, signal });
  },

  async refresh(connectionId: string, signal?: AbortSignal) {
    return apiRequest<ConnectionView>(`/connections/${connectionId}/refresh`, { method: "POST", signal });
  },

  async disconnect(connectionId: string, signal?: AbortSignal) {
    return apiRequest<ConnectionView>(`/connections/${connectionId}/disconnect`, { method: "POST", signal });
  },
};
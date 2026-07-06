import { Buffer } from "node:buffer";

export class GrafanaClient {
  constructor(config) {
    this.baseUrl = config.grafana.baseUrl.replace(/\/$/, "");
    this.orgId = config.grafana.orgId;
    this.token = config.grafana.token;
    this.cookie = config.grafana.cookie;
    this.username = config.grafana.username;
    this.password = config.grafana.password;
    this.requestTimeoutMs = (config.grafana.requestTimeoutSeconds || 15) * 1000;
  }

  async getDashboardByUid(uid) {
    return this.requestJson(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  }

  async queryData(queries, timeRange) {
    return this.requestJson("/api/ds/query", {
      method: "POST",
      body: JSON.stringify({
        from: `${timeRange.fromMs}`,
        to: `${timeRange.toMs}`,
        queries,
      }),
    });
  }

  async requestJson(pathname, options = {}) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...this.buildAuthHeaders(),
      ...options.headers,
    };

    if (this.orgId !== undefined) {
      headers["X-Grafana-Org-Id"] = `${this.orgId}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        ...options,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Grafana request timed out after ${this.requestTimeoutMs / 1000}s: ${pathname}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Grafana request failed (${response.status} ${response.statusText}): ${body.slice(0, 240)}`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const body = await response.text();
      throw new Error(
        `Expected JSON response but got ${contentType || "unknown content type"}: ${body.slice(0, 240)}`,
      );
    }

    return response.json();
  }

  buildAuthHeaders() {
    const headers = {};

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    } else if (this.username) {
      const encoded = Buffer.from(`${this.username}:${this.password || ""}`).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
    }

    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    return headers;
  }
}

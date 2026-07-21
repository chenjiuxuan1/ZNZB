import { fetchCompatible } from "./fetch-compatible.mjs";

export class MetabasePublicClient {
  constructor({
    baseUrl,
    requestTimeoutSeconds = 30,
    retryCount = 2,
    retryDelayMs = 250,
    fetchFn = fetchCompatible,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = requestTimeoutSeconds * 1000;
    this.retryCount = retryCount;
    this.retryDelayMs = retryDelayMs;
    this.fetchFn = fetchFn;
  }

  async getDashboard(uuid) {
    return this.requestJson(`/api/public/dashboard/${encodeURIComponent(uuid)}`, {
      method: "GET",
    });
  }

  async queryDashcardJson({ cardId, dashboardUuid, dashcardId, parameters = [] }) {
    return this.requestJson(
      `/api/public/dashboard/${encodeURIComponent(dashboardUuid)}/dashcard/${dashcardId}/card/${cardId}/json`,
      {
        method: "POST",
        body: JSON.stringify({ parameters }),
      },
    );
  }

  async requestJson(pathname, options = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        return await this.requestJsonOnce(pathname, options);
      } catch (error) {
        lastError = error;
        if (!isRetryableGatewayError(error) || attempt >= this.retryCount) {
          throw error;
        }
        await delay(this.retryDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async requestJsonOnce(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${pathname}`, {
        ...options,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Metabase public request timed out after ${this.timeoutMs / 1000}s: ${pathname}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `Metabase public request failed (${response.status} ${response.statusText}): ${body.slice(0, 240)}`,
      );
    }

    if (!contentType.includes("application/json")) {
      throw new Error(
        `Metabase expected JSON but got ${contentType || "unknown content type"}: ${body.slice(0, 240)}`,
      );
    }

    return JSON.parse(body);
  }
}

function isRetryableGatewayError(error) {
  return /Metabase public request failed \((502|503|504)\b/.test(String(error?.message || error));
}

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function parsePublicDashboardUrl(urlString) {
  const url = new URL(urlString);
  const match = url.pathname.match(/^\/public\/dashboard\/([^/?#]+)/);

  if (!match) {
    return null;
  }

  return {
    baseUrl: url.origin,
    uuid: match[1],
    url: urlString,
  };
}

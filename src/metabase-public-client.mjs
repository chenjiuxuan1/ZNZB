export class MetabasePublicClient {
  constructor({ baseUrl, requestTimeoutSeconds = 30 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = requestTimeoutSeconds * 1000;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
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


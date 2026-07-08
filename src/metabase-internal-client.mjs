export class MetabaseInternalClient {
  constructor({
    baseUrl,
    sessionToken = process.env.METABASE_SESSION || "",
    cookie = process.env.METABASE_COOKIE || "",
    requestTimeoutSeconds = 30,
    fetchFn = fetch,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sessionToken = sessionToken;
    this.cookie = cookie;
    this.timeoutMs = requestTimeoutSeconds * 1000;
    this.fetchFn = fetchFn;
  }

  async getDashboard(id) {
    return this.requestJson(`/api/dashboard/${encodeURIComponent(id)}`, {
      method: "GET",
    });
  }

  async getCollectionItems(id) {
    return this.requestJson(`/api/collection/${encodeURIComponent(id)}/items`, {
      method: "GET",
    });
  }

  async queryDashcardJson({ cardId, dashboardId, dashcardId, parameters = [] }) {
    return this.requestJson(
      `/api/dashboard/${encodeURIComponent(dashboardId)}/dashcard/${dashcardId}/card/${cardId}/query/json`,
      {
        method: "POST",
        body: JSON.stringify({ parameters }),
      },
    );
  }

  async requestJson(pathname, options = {}) {
    if (!this.sessionToken && !this.cookie) {
      throw new Error("Metabase internal access requires METABASE_SESSION or METABASE_COOKIE");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${pathname}`, {
        ...options,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...authHeaders(this.sessionToken, this.cookie),
          ...options.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Metabase internal request timed out after ${this.timeoutMs / 1000}s: ${pathname}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `Metabase internal request failed (${response.status} ${response.statusText}): ${body.slice(0, 240)}`,
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

export function parseInternalMetabaseUrl(urlString) {
  const url = new URL(urlString);
  const dashboardMatch = url.pathname.match(/^\/dashboard\/(\d+)/);
  if (dashboardMatch) {
    return {
      baseUrl: url.origin,
      type: "dashboard",
      id: dashboardMatch[1],
      url: urlString,
    };
  }

  const collectionMatch = url.pathname.match(/^\/collection\/(\d+)/);
  if (collectionMatch) {
    return {
      baseUrl: url.origin,
      type: "collection",
      id: collectionMatch[1],
      url: urlString,
    };
  }

  return null;
}

function authHeaders(sessionToken, cookie) {
  const headers = {};
  if (sessionToken) {
    headers["X-Metabase-Session"] = sessionToken;
  }
  if (cookie) {
    headers.Cookie = cookie.includes("=") ? cookie : `metabase.SESSION=${cookie}`;
  }
  return headers;
}

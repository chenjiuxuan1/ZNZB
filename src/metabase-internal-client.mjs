import fs from "node:fs";
import { fetchCompatible } from "./fetch-compatible.mjs";

export class MetabaseInternalClient {
  constructor({
    baseUrl,
    sessionToken,
    cookie,
    apiKey,
    requestTimeoutSeconds = 30,
    fetchFn = fetchCompatible,
  }) {
    const auth = resolveMetabaseAuth();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.sessionToken = sessionToken ?? auth.sessionToken;
    this.cookie = cookie ?? auth.cookie;
    this.apiKey = apiKey ?? auth.apiKey;
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
    if (!this.sessionToken && !this.cookie && !this.apiKey) {
      throw new Error("Metabase internal access requires METABASE_SESSION, METABASE_COOKIE, or METABASE_API_KEY");
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
          ...authHeaders(this.sessionToken, this.cookie, this.apiKey),
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

export function hasMetabaseInternalAuth() {
  const auth = resolveMetabaseAuth();
  return Boolean(auth.sessionToken || auth.cookie || auth.apiKey);
}

export function resolveMetabaseAuth() {
  const fileAuth = loadMetabaseAuthFile();
  return {
    sessionToken: process.env.METABASE_SESSION || fileAuth.sessionToken || "",
    cookie: process.env.METABASE_COOKIE || fileAuth.cookie || "",
    apiKey: process.env.METABASE_API_KEY || fileAuth.apiKey || "",
  };
}

function loadMetabaseAuthFile() {
  const authFile = process.env.METABASE_AUTH_FILE || "config/metabase.auth.json";
  try {
    if (!fs.existsSync(authFile)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(authFile, "utf8"));
    return {
      sessionToken: raw.sessionToken || raw.session || raw.metabaseSession || "",
      cookie: raw.cookie || raw.metabaseCookie || "",
      apiKey: raw.apiKey || raw.metabaseApiKey || "",
    };
  } catch (error) {
    throw new Error(`Failed to read Metabase auth file ${authFile}: ${error.message}`);
  }
}

function authHeaders(sessionToken, cookie, apiKey) {
  const headers = {};
  if (sessionToken) {
    headers["X-Metabase-Session"] = sessionToken;
  }
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  if (cookie) {
    headers.Cookie = cookie.includes("=") ? cookie : `metabase.SESSION=${cookie}`;
  }
  return headers;
}

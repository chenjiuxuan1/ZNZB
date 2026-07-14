import { fetchCompatible } from "./fetch-compatible.mjs";

const DEFAULT_DASHCARD_PATH = "/api/bi-monitor/metabase/public-dashcard-json";

export class BiGatewayClient {
  constructor({ baseUrl, token = "", requestTimeoutSeconds = 60, dashcardPath = DEFAULT_DASHCARD_PATH } = {}) {
    if (!baseUrl) {
      throw new Error("BI Gateway baseUrl is required");
    }

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = requestTimeoutSeconds * 1000;
    this.dashcardPath = dashcardPath || DEFAULT_DASHCARD_PATH;
  }

  async queryPublicDashcardJson({ dashboard, card, parameters = [] }) {
    const payload = {
      taskName: "metabase-public-dashcard-json",
      country: normalizeCountry(dashboard),
      dashboard: {
        title: dashboard.title,
        sourcePanelTitle: dashboard.sourcePanelTitle,
        uuid: dashboard.uuid,
        url: dashboard.url,
      },
      card: {
        title: card.title,
        cardId: card.cardId,
        dashcardId: card.dashcardId,
        display: card.display,
      },
      parameters,
      timeoutSec: this.timeoutMs / 1000,
    };

    const response = await this.requestJson(this.dashcardPath, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    return extractRows(response);
  }

  async requestJson(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetchCompatible(buildUrl(this.baseUrl, pathname), {
        ...options,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...authorizationHeader(this.token),
          ...options.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`BI Gateway request timed out after ${this.timeoutMs / 1000}s: ${pathname}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const body = await response.text();
    const parsed = parseJsonBody(body, response.headers.get("content-type") || "");

    if (!response.ok) {
      throw new Error(
        `BI Gateway request failed (${response.status} ${response.statusText}): ${formatGatewayError(parsed, body)}`,
      );
    }

    if (parsed && parsed.success === false) {
      throw new Error(`BI Gateway request failed: ${formatGatewayError(parsed, body)}`);
    }

    return parsed;
  }
}

export function createGatewayQueryCardFn(options = {}) {
  const gateway = new BiGatewayClient(options);

  return async (_client, dashboard, card, parameters = []) => {
    try {
      const rows = await gateway.queryPublicDashcardJson({ dashboard, card, parameters });
      return {
        ok: true,
        rows: Array.isArray(rows) ? rows : [],
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        rows: [],
        error: error.message,
      };
    }
  };
}

export function extractRows(response) {
  const candidates = [
    response,
    response?.rows,
    response?.data,
    response?.data?.rows,
    response?.result,
    response?.result?.rows,
    response?.result?.data,
    response?.result?.data?.rows,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  throw new Error("BI Gateway response does not contain rows array");
}

function normalizeCountry(dashboard) {
  const country = dashboard.country || {};

  return {
    code: dashboard.countryCode || country.code || null,
    name: dashboard.countryName || country.name || null,
    timezone: dashboard.timezone || country.timezone || null,
  };
}

function buildUrl(baseUrl, pathname) {
  if (/^https?:\/\//.test(pathname)) {
    return pathname;
  }

  return `${baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function authorizationHeader(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function parseJsonBody(body, contentType) {
  if (!body) {
    return null;
  }

  if (!contentType.includes("application/json") && !body.trim().startsWith("{") && !body.trim().startsWith("[")) {
    throw new Error(`BI Gateway expected JSON but got ${contentType || "unknown content type"}: ${body.slice(0, 240)}`);
  }

  return JSON.parse(body);
}

function formatGatewayError(parsed, rawBody) {
  if (!parsed || typeof parsed !== "object") {
    return rawBody.slice(0, 240);
  }

  const parts = [
    parsed.message,
    parsed.error,
    parsed.detail,
    parsed.traceId || parsed.trace_id ? `traceId=${parsed.traceId || parsed.trace_id}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join("; ") : JSON.stringify(parsed).slice(0, 240);
}

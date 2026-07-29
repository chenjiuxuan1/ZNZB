import { fetchCompatible } from "./fetch-compatible.mjs";

const COUNTRY_CODES = new Set(["cn", "ine", "ph", "th", "pk", "mx"]);
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:5678/webhook/warehouse-lineage";

export function assertWarehouseLineageToolAuthorized(request, env = process.env) {
  const expected = String(env.DIFY_WAREHOUSE_LINEAGE_TOOL_TOKEN || "").trim();
  if (!expected) {
    const error = new Error("Warehouse lineage tool is not configured");
    error.statusCode = 503;
    throw error;
  }
  const received = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (received !== expected) {
    const error = new Error("Unauthorized warehouse lineage tool request");
    error.statusCode = 401;
    throw error;
  }
}

export function normalizeWarehouseLineageRequest(body = {}) {
  const operation = String(body.operation || "").trim();
  const countryCode = String(body.countryCode || "").trim().toLowerCase();
  const table = String(body.table || "").trim();
  const requestedMaxFiles = Number(body.maxFiles || 10);

  if (operation !== "trace_table") {
    const error = new Error("Only trace_table is supported");
    error.statusCode = 400;
    throw error;
  }
  if (!COUNTRY_CODES.has(countryCode)) {
    const error = new Error("Unsupported countryCode; use cn/ine/ph/th/pk/mx");
    error.statusCode = 400;
    throw error;
  }
  if (!TABLE_NAME_PATTERN.test(table)) {
    const error = new Error("Invalid table name");
    error.statusCode = 400;
    throw error;
  }

  return {
    operation,
    countryCode,
    table,
    maxFiles: Number.isFinite(requestedMaxFiles) ? Math.max(1, Math.min(20, Math.floor(requestedMaxFiles))) : 10,
  };
}

export async function proxyWarehouseLineageRequest(body, {
  env = process.env,
  fetchFn = fetchCompatible,
} = {}) {
  const request = normalizeWarehouseLineageRequest(body);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 65_000) : null;
  try {
    const response = await fetchFn(String(env.WAREHOUSE_LINEAGE_GATEWAY_URL || DEFAULT_GATEWAY_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller?.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { error: "Warehouse lineage gateway returned invalid JSON" };
    }
    if (!response.ok) {
      const error = new Error(payload.error || `Warehouse lineage gateway failed (${response.status})`);
      error.statusCode = response.status >= 400 && response.status < 600 ? response.status : 502;
      throw error;
    }
    return payload;
  } catch (cause) {
    if (cause.statusCode) throw cause;
    const error = new Error(`Warehouse lineage gateway unavailable: ${cause.message}`);
    error.statusCode = 502;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

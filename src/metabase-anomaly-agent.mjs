import { MAX_CASES_PER_BATCH } from "./metabase-anomaly-batch.mjs";

const DEFAULT_N8N_WEBHOOK_URL = process.env.METABASE_ANOMALY_N8N_WEBHOOK_URL || "";
const DEFAULT_CALLBACK_BASE_URL = process.env.PLATFORM_BASE_URL || "http://localhost:8787";

export const DASHBOARD_ANALYSIS_STAGE = "dashboard_analysis";

/**
 * Validate and dispatch a single-stage dashboard analysis batch to the n8n
 * Agent gateway. Each batch maps to exactly one Dify conversation.
 */
export async function analyzeMetabaseAnomalyBatch(batch, options = {}) {
  const validation = validateDashboardAnalysisBatch(batch);
  if (!validation.ok) {
    const error = new Error(`批量分析验证失败: ${validation.errors.join("; ")}`);
    error.statusCode = 400;
    error.errors = validation.errors;
    throw error;
  }

  return requestN8nAgentBatch(batch, options);
}

export function validateDashboardAnalysisBatch(batch) {
  const errors = [];
  if (!batch || typeof batch !== "object") {
    errors.push("batch must be an object");
    return { ok: false, errors };
  }

  if (batch.stage !== DASHBOARD_ANALYSIS_STAGE) {
    errors.push(`stage must be "${DASHBOARD_ANALYSIS_STAGE}"`);
  }

  if (!Array.isArray(batch.cases)) {
    errors.push("cases must be an array");
  } else if (batch.cases.length === 0) {
    errors.push("cases must not be empty");
  } else if (batch.cases.length > MAX_CASES_PER_BATCH) {
    errors.push(`cases must not exceed ${MAX_CASES_PER_BATCH}`);
  } else {
    for (const [index, item] of batch.cases.entries()) {
      if (!item || typeof item !== "object") {
        errors.push(`cases[${index}] must be an object`);
        continue;
      }
      if (typeof item.anomalyIndex !== "number") {
        errors.push(`cases[${index}].anomalyIndex must be a number`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * POST a batch to the n8n Agent gateway. The payload is intentionally minimal:
 * no screeningVerdict, no sourceTable, no stage branch. Dify returns the final
 * verdicts array directly.
 */
export async function requestN8nAgentBatch(batch, options = {}) {
  const webhookUrl = options.webhookUrl || DEFAULT_N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Missing n8n webhook URL for Metabase anomaly analysis");
  }

  const callbackBaseUrl = options.callbackBaseUrl || DEFAULT_CALLBACK_BASE_URL;
  const callbackUrl = `${callbackBaseUrl.replace(/\/$/, "")}/api/metabase-anomaly-analysis/batch-callback`;

  const payload = {
    batchId: batch.id,
    dashboardUuid: batch.dashboardUuid,
    dashboardTitle: batch.dashboardTitle || "",
    cases: batch.cases,
    callbackUrl,
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`n8n gateway returned ${response.status}: ${text}`);
  }

  const data = await response.json().catch(() => ({}));
  return {
    ok: true,
    batchId: batch.id,
    gatewayResponse: data,
  };
}

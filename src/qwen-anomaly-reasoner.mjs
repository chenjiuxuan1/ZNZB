import { assertReadOnlySql } from "./sr-box-verification-client.mjs";
import { fetchCompatible } from "./fetch-compatible.mjs";

const DEFAULT_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.6-plus";
const DEFAULT_API_KEY_ENV = "DASHSCOPE_API_KEY";

export class QwenAnomalyReasoner {
  constructor(config = {}, dependencies = {}) {
    this.enabled = config.enabled === true;
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = String(config.model || DEFAULT_MODEL);
    this.apiKeyEnv = String(config.apiKeyEnv || DEFAULT_API_KEY_ENV);
    this.apiKey = dependencies.apiKey ?? process.env[this.apiKeyEnv] ?? "";
    this.fetchFn = dependencies.fetchFn || fetchCompatible;
    this.timeoutMs = positiveNumber(config.timeoutSeconds, 60) * 1000;
    this.temperature = boundedNumber(config.temperature, 0, 1, 0.1);
    this.maxTokens = positiveInteger(config.maxTokens, 1800);
  }

  async analyze({ mode = "evidence-review", anomaly = {}, plan = null, decision = null, evidence = null } = {}) {
    if (!this.enabled) {
      return {
        enabled: false,
        status: "disabled",
        model: this.model,
      };
    }
    if (!this.apiKey) {
      return {
        enabled: true,
        status: "unavailable",
        model: this.model,
        reason: `环境变量 ${this.apiKeyEnv} 未配置`,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          messages: buildMessages({ mode, anomaly, plan, decision, evidence }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Qwen anomaly reasoning timed out after ${this.timeoutMs / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const body = await response.text();
    const payload = parseJson(body);
    if (!response.ok) {
      throw new Error(
        `Qwen anomaly reasoning failed (${response.status} ${response.statusText}): ${
          payload?.error?.message || body.slice(0, 500)
        }`,
      );
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Qwen anomaly reasoning returned no message content");
    }
    const analysis = normalizeAnalysis(parseModelContent(content));
    return {
      enabled: true,
      status: "completed",
      model: this.model,
      ...analysis,
      usage: sanitizeUsage(payload.usage),
    };
  }
}

export function createQwenAnomalyReasoner(config = {}, dependencies = {}) {
  return new QwenAnomalyReasoner(config, dependencies);
}

function buildMessages({ mode, anomaly, plan, decision, evidence }) {
  const task = mode === "plan-suggestion"
    ? "当前候选异常没有已审核的血缘计划。请提出调查方向、可能的表层级和只读 SQL 草案；不要下最终正常结论。"
    : "请解释确定性数据库复核证据，指出可能原因和下一步调查建议；不得覆盖数据库判定状态。";
  const input = {
    mode,
    anomaly: sanitizeAnomaly(anomaly),
    configuredLineage: plan ? {
      planId: plan.id,
      route: plan.route,
      sourceTables: plan.sourceTables,
    } : null,
    deterministicDecision: decision ? {
      status: decision.status,
      confidence: decision.confidence,
      reason: decision.reason,
    } : null,
    standardizedEvidence: evidence ? {
      sourceComplete: evidence.sourceComplete,
      dataQualityIssue: evidence.dataQualityIssue,
      isAnomaly: evidence.isAnomaly,
      observedValue: evidence.observedValue,
      baselineLow: evidence.baselineLow,
      baselineHigh: evidence.baselineHigh,
      lineage: evidence.lineage,
    } : null,
  };

  return [
    {
      role: "system",
      content: [
        "你是数仓异常复核规划助手，只负责分析和建议，不拥有最终判定权。",
        "禁止输出或建议任何写 SQL；SQL 只能是 SELECT、WITH、SHOW、DESC、DESCRIBE、EXPLAIN。",
        "不能因为没有证据、查询失败或权限不足而把异常判断为正常。",
        "不要虚构已经确认的表名、字段、口径或查询结果；不确定项必须明确标记为假设。",
        "只返回一个 JSON 对象，不要使用 Markdown 代码块。",
        "JSON 字段：summary、likelyCause、lineageHints、suggestedReadOnlySql、recommendation、confidence、warnings。",
        "recommendation 只能是 confirmed_anomaly、false_positive、data_quality_issue、unverified 之一。",
      ].join("\n"),
    },
    {
      role: "user",
      content: `${task}\n\n输入：${JSON.stringify(input)}`,
    },
  ];
}

function sanitizeAnomaly(anomaly) {
  return {
    countryCode: limitText(anomaly.countryCode, 32),
    countryName: limitText(anomaly.countryName, 80),
    dashboardTitle: limitText(anomaly.dashboardTitle, 200),
    dashboardUuid: limitText(anomaly.dashboardUuid, 120),
    cardTitle: limitText(anomaly.cardTitle, 200),
    cardId: normalizeScalar(anomaly.cardId),
    dashcardId: normalizeScalar(anomaly.dashcardId),
    type: limitText(anomaly.type, 100),
    context: limitText(anomaly.context, 500),
    message: limitText(anomaly.message, 1500),
  };
}

function normalizeAnalysis(value = {}) {
  const suggestedSql = Array.isArray(value.suggestedReadOnlySql)
    ? value.suggestedReadOnlySql
      .map((sql) => limitText(sql, 4000))
      .filter(Boolean)
      .filter(isReadOnlySuggestion)
      .slice(0, 5)
    : [];

  return {
    summary: limitText(value.summary, 1200),
    likelyCause: limitText(value.likelyCause, 1200),
    lineageHints: normalizeTextList(value.lineageHints, 10, 500),
    suggestedReadOnlySql: suggestedSql,
    recommendation: normalizeRecommendation(value.recommendation),
    confidence: boundedNumber(value.confidence, 0, 1, 0),
    warnings: normalizeTextList(value.warnings, 10, 500),
  };
}

function isReadOnlySuggestion(sql) {
  try {
    assertReadOnlySql(sql);
    return true;
  } catch {
    return false;
  }
}

function normalizeRecommendation(value) {
  const text = String(value || "").trim().toLowerCase();
  return [
    "confirmed_anomaly",
    "false_positive",
    "data_quality_issue",
    "unverified",
  ].includes(text) ? text : "unverified";
}

function parseModelContent(content) {
  if (typeof content === "object" && content !== null) {
    return content;
  }
  const text = String(content || "").trim();
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const parsed = parseJson(withoutFence);
  if (!parsed) {
    throw new Error("Qwen anomaly reasoning returned invalid JSON content");
  }
  return parsed;
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function sanitizeUsage(usage = {}) {
  return {
    promptTokens: Number(usage.prompt_tokens || 0),
    completionTokens: Number(usage.completion_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
  };
}

function normalizeTextList(value, maxItems, maxLength) {
  return Array.isArray(value)
    ? value.map((item) => limitText(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

function limitText(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeScalar(value) {
  return value === undefined ? null : value;
}

import { randomUUID } from "node:crypto";
import { fetchCompatible } from "./fetch-compatible.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const N8N_ASYNC_ACCEPT_WAIT_MS = 2_500;
const DEFAULT_INTERNAL_CALLBACK_URL = "http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback";
const AGENT_NAME = "Metabase 异常原因分析助手";
const AGENT_MODES = new Set(["summary", "evidence", "recursive_evidence"]);

export function getMetabaseAnomalyAgentSettings(env = process.env) {
  const enabledValue = String(env.METABASE_ANOMALY_AGENT_ENABLED || "").trim().toLowerCase();
  const n8nWebhookUrl = String(env.METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL || "").trim();
  const n8nBatchWebhookUrl = String(env.METABASE_ANOMALY_AGENT_N8N_BATCH_WEBHOOK_URL || "").trim();
  const n8nToken = String(env.METABASE_ANOMALY_AGENT_N8N_TOKEN || "").trim();
  const asyncSetting = String(env.METABASE_ANOMALY_AGENT_N8N_ASYNC || "").trim().toLowerCase();
  // n8n webhooks run evidence jobs by default. Legacy synchronous behavior is
  // still available only through an explicit false value.
  const n8nAsync = Boolean(n8nWebhookUrl) && !["0", "false", "off", "no"].includes(asyncSetting);
  const callbackUrl = String(env.METABASE_ANOMALY_AGENT_CALLBACK_URL || (n8nAsync && n8nWebhookUrl ? DEFAULT_INTERNAL_CALLBACK_URL : "")).trim();
  const callbackToken = String(env.METABASE_ANOMALY_AGENT_CALLBACK_TOKEN || "").trim();
  const baseUrl = String(env.METABASE_ANOMALY_AGENT_BASE_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(env.METABASE_ANOMALY_AGENT_API_KEY || "").trim();
  const model = String(env.METABASE_ANOMALY_AGENT_MODEL || "").trim();
  const requestedMode = normalizeRequestedMode(env.METABASE_ANOMALY_AGENT_MODE, n8nAsync ? "evidence" : "summary");
  const explicitlyDisabled = ["0", "false", "off", "no"].includes(enabledValue);
  const transport = n8nWebhookUrl ? "n8n" : "direct";
  const configured = transport === "n8n"
    ? Boolean(n8nWebhookUrl && n8nToken && (!n8nAsync || (callbackUrl && callbackToken)))
    : Boolean(baseUrl && apiKey && model);
  return {
    enabled: !explicitlyDisabled && configured,
    configured,
    baseUrl,
    apiKey,
    model,
    transport,
    n8nWebhookUrl,
    n8nBatchWebhookUrl,
    n8nToken,
    n8nAsync,
    callbackUrl,
    callbackToken,
    requestedMode,
    langfuse: getLangfuseSettings(env),
  };
}

export async function analyzeMetabaseAnomaly({ anomaly, context = {}, env = process.env, fetchFn = fetchCompatible } = {}) {
  const settings = getMetabaseAnomalyAgentSettings(env);
  if (!settings.enabled) {
    const error = new Error("Metabase 异常分析 Agent 未配置。请设置 n8n Webhook；异步取证还需配置 CALLBACK_URL 与 CALLBACK_TOKEN，或设置直连模型配置。");
    error.statusCode = 503;
    throw error;
  }
  if (!anomaly || typeof anomaly !== "object") {
    throw new Error("Metabase 异常分析缺少异常证据。");
  }

  if (settings.transport === "n8n") {
    return callN8nAgent({ settings, anomaly, context, fetchFn });
  }

  const promptMessages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: buildEvidencePrompt(anomaly, context) },
  ];
  const startedAt = new Date();
  const modelResponse = await callModel({ settings, promptMessages, fetchFn });
  const parsed = parseAnalysisOrFallback(modelResponse.rawOutput);
  const analysis = normalizeMetabaseAnomalyAnalysis(parsed.value);
  const trace = await writeLangfuseTrace({
    settings: settings.langfuse,
    fetchFn,
    promptMessages,
    rawOutput: modelResponse.rawOutput,
    analysis,
    model: modelResponse.model || settings.model,
    tokenUsage: modelResponse.tokenUsage,
    anomaly,
    context,
    startedAt,
    fallbackUsed: parsed.fallbackUsed,
  });

  return {
    generatedAt: new Date().toISOString(),
    provider: "openai-compatible",
    model: modelResponse.model || settings.model,
    analysis,
    fallbackUsed: parsed.fallbackUsed,
    observability: trace,
  };
}

export async function analyzeMetabaseAnomalyBatch({ batch = {}, env = process.env, fetchFn = fetchCompatible } = {}) {
 const settings = getMetabaseAnomalyAgentSettings(env);
 const cases = Array.isArray(batch.cases) ? batch.cases : [];
  const stage = "dashboard_analysis";
 if (!settings.enabled || settings.transport !== "n8n") {
   const error = new Error("批量 Metabase 异常分析需要已配置的异步 n8n Agent。");
   error.statusCode = 503;
   throw error;
 }
 const payloadBytes = Buffer.byteLength(JSON.stringify({ ...batch, stage, cases }), "utf8");
 const validationErrors = [];
 if (!batch.batchId) validationErrors.push("batchId missing");
 if (!batch.runId) validationErrors.push("runId missing");
 if (!batch.countryCode) validationErrors.push("countryCode missing");
 if (!batch.snapshotId) validationErrors.push("snapshotId missing");
 if (cases.length === 0) validationErrors.push("cases empty");
 if (payloadBytes > 512 * 1024) validationErrors.push(`payload ${payloadBytes} bytes exceeds 512 KiB`);
 if (validationErrors.length > 0) {
   const detail = `stage=${stage}, countryCode=${batch.countryCode || "(empty)"}, batchId=${String(batch.batchId || "").slice(0, 20)}, runId=${String(batch.runId || "").slice(0, 20)}, snapshotId=${String(batch.snapshotId || "").slice(0, 20)}, cases=${cases.length}, payloadBytes=${payloadBytes}`;
   console.error(`[metabase-anomaly-agent] batch validation FAILED: ${validationErrors.join(", ")} | ${detail}`);
    const error = new Error(`Metabase 看板分析验证失败: ${validationErrors.join("; ")}`);
   error.statusCode = 400;
   throw error;
 }
  const jobId = String(batch.jobId || randomUUID());
  const batchUrl = settings.n8nBatchWebhookUrl || settings.n8nWebhookUrl;
  console.error(`[metabase-anomaly-agent] batch dispatch: jobId=${jobId} batchId=${String(batch.batchId).slice(0,20)} cases=${cases.length} url=${batchUrl} enabled=${settings.enabled} async=${settings.n8nAsync}`);
  const request = requestN8nAgentBatch({ settings, batch: { ...batch, stage, cases }, fetchFn, jobId });
  const settled = request.then((value) => ({ value }), (error) => ({ error }));
  const first = await Promise.race([
    settled,
    delay(N8N_ASYNC_ACCEPT_WAIT_MS).then(() => null),
  ]);
  if (!first) {
    console.error(`[metabase-anomaly-agent] batch dispatch TIMEOUT (>${N8N_ASYNC_ACCEPT_WAIT_MS}ms) for ${jobId}, returning pending`);
    void settled.then(({ error }) => {
      if (error) console.error(`[metabase-anomaly-agent] n8n batch dispatch failed for ${jobId}: ${error.message}`);
    });
    return { ...pendingN8nEvidenceJob({ jobId }), batchId: String(batch.batchId) };
  }
  if (first.error) {
    console.error(`[metabase-anomaly-agent] batch dispatch ERROR for ${jobId}: ${first.error.message}`);
    throw first.error;
  }
  console.error(`[metabase-anomaly-agent] batch dispatch ACCEPTED for ${jobId}: ${JSON.stringify(first.value.payload || {}).slice(0, 200)}`);
  const payload = first.value.payload || {};
  if (!(payload.accepted === true || payload.status === "pending" || payload.jobId)) {
    const error = new Error("n8n 未受理批量 Metabase 异常分析任务。");
    error.statusCode = 502;
    throw error;
  }
  return {
    ...pendingN8nEvidenceJob({ jobId: String(payload.jobId || payload.executionId || jobId) }),
    batchId: String(batch.batchId),
  };
}

async function callN8nAgent({ settings, anomaly, context, fetchFn }) {
  // The platform may supply an ID so callbacks and the pending cache always
  // refer to the same job, even when a user retries quickly.
  const jobId = settings.n8nAsync ? String(context.jobId || randomUUID()) : "";
  const request = requestN8nAgent({ settings, anomaly, context, fetchFn, jobId });

  // n8n may continue executing after the reverse proxy's short response window.
  // Do not turn a live async evidence job into a browser-visible 502 in that case.
  if (settings.n8nAsync) {
    const settled = request.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const first = await Promise.race([
      settled,
      delay(N8N_ASYNC_ACCEPT_WAIT_MS).then(() => null),
    ]);
    if (!first) {
      void settled.then(({ error }) => {
        if (error) console.error(`[metabase-anomaly-agent] n8n async dispatch failed for ${jobId}: ${error.message}`);
      });
      return pendingN8nEvidenceJob({ jobId });
    }
    if (first.error) throw first.error;
    return normalizeN8nAgentResponse({ settings, payload: first.value.payload, jobId });
  }

  const { payload } = await request;
  return normalizeN8nAgentResponse({ settings, payload, jobId });
}

async function requestN8nAgent({ settings, anomaly, context, fetchFn, jobId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetchFn(settings.n8nWebhookUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(settings.n8nToken ? { Authorization: `Bearer ${settings.n8nToken}` } : {}),
      },
      body: JSON.stringify({
        protocolVersion: 2,
        ...(jobId ? { jobId } : {}),
        // The mode is opt-in. Existing deployments continue using the current
        // one-pass evidence workflow until the recursive workflow is imported.
        requestedMode: settings.requestedMode,
        anomaly: pickAnomalyEvidence(anomaly),
        context: { ...pickContextEvidence(context), sameDashboardAnomalies: (context.sameDashboardAnomalies || []).slice(0, 5).map(pickAnomalyEvidence) },
        callback: settings.n8nAsync && settings.callbackUrl ? {
          url: settings.callbackUrl,
          token: settings.callbackToken || null,
        } : null,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const error = new Error(payload?.error?.message || payload?.error || `n8n Agent 请求失败（HTTP ${response.status}）`);
      error.statusCode = 502;
      throw error;
    }
    return { payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestN8nAgentBatch({ settings, batch, fetchFn, jobId }) {
 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), 60_000);
 try {
   const batchUrl = settings.n8nBatchWebhookUrl || settings.n8nWebhookUrl;
   let response;
   try {
     response = await fetchFn(batchUrl, {
     method: "POST",
     headers: {
       Accept: "application/json",
       "Content-Type": "application/json",
       Authorization: `Bearer ${settings.n8nToken}`,
     },
     body: JSON.stringify({
        protocolVersion: 5,
       jobId,
       job: {
          stage: "dashboard_analysis",
         batchId: String(batch.batchId),
         runId: String(batch.runId),
         countryCode: String(batch.countryCode).toUpperCase(),
         snapshotId: String(batch.snapshotId),
         dashboardUuid: String(batch.dashboardUuid || ""),
         dashboardTitle: String(batch.dashboardTitle || ""),
         sourceTable: String(batch.sourceTable || ""),
         cases: batch.cases,
       },
       callback: {
          url: resolveBatchCallbackUrl(settings.callbackUrl),
         token: settings.callbackToken || null,
       },
     }),
     signal: controller.signal,
   });
   } catch (networkError) {
     const error = new Error(`无法连接 n8n Webhook (${batchUrl})，请确认 n8n 已启动且工作流已导入: ${networkError.message}`);
     error.statusCode = 502;
     throw error;
   }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      const error = new Error(payload?.error?.message || payload?.error || `n8n 批量 Agent 请求失败（HTTP ${response.status}），请检查 n8n 工作流是否已导入最新模板`);
      error.statusCode = 502;
      throw error;
    }
    return { payload };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveBatchCallbackUrl(callbackUrl) {
  const value = String(callbackUrl || "").replace(/\/+$/, "");
  return value.replace(/\/callback$/, "/batch-callback");
}

function normalizeRequestedMode(value, fallback) {
  const mode = String(value || "").trim().toLowerCase();
  return AGENT_MODES.has(mode) ? mode : fallback;
}

function normalizeN8nAgentResponse({ settings, payload, jobId }) {
  if (settings.n8nAsync && (payload?.accepted === true || payload?.status === "pending" || payload?.jobId)) {
    return pendingN8nEvidenceJob({
      jobId: String(payload?.jobId || payload?.executionId || jobId || randomUUID()),
      generatedAt: payload?.generatedAt,
      model: payload?.model,
      observability: payload?.observability,
    });
  }
  if (!payload?.analysis) {
    const error = new Error("n8n Agent 未返回分析结果或异步任务编号");
    error.statusCode = 502;
    throw error;
  }
  return {
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    provider: "n8n",
    model: String(payload?.model || "n8n-configured-model"),
    analysis: normalizeMetabaseAnomalyAnalysis(payload?.analysis),
    fallbackUsed: Boolean(payload?.fallbackUsed),
    observability: payload?.observability || { enabled: false, written: false, reason: "n8n 未返回 Langfuse 状态" },
  };
}

function pendingN8nEvidenceJob({ jobId, generatedAt, model, observability } = {}) {
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    provider: "n8n-evidence",
    pending: true,
    jobId: String(jobId || randomUUID()),
    model: String(model || "n8n-configured-model"),
    observability: observability || { enabled: false, written: false, reason: "n8n 任务已受理，等待回调" },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callModel({ settings, promptMessages, fetchFn }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchFn(resolveChatCompletionsUrl(settings.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.model, messages: promptMessages, stream: false, temperature: 0.2 }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `模型请求失败（HTTP ${response.status}）`;
      const error = new Error(message);
      error.statusCode = 502;
      throw error;
    }
    return {
      rawOutput: extractModelContent(payload),
      model: String(payload?.model || settings.model),
      tokenUsage: normalizeTokenUsage(payload?.usage),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeLangfuseTrace({ settings, fetchFn, promptMessages, rawOutput, analysis, model, tokenUsage, anomaly, context, startedAt, fallbackUsed }) {
  if (!settings.enabled) {
    return { enabled: false, written: false, reason: settings.reason };
  }
  const traceId = langfuseId();
  const generationId = langfuseId();
  const batch = buildLangfuseBatch({
    traceId,
    generationId,
    promptMessages,
    rawOutput,
    analysis,
    model,
    tokenUsage,
    anomaly,
    context,
    startedAt,
    fallbackUsed,
  });
  try {
    const response = await fetchFn(`${settings.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString("base64")}`,
        "User-Agent": "metabase-anomaly-agent/1.0",
      },
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      return { enabled: true, written: false, traceId, generationId, error: `HTTP ${response.status}` };
    }
    return { enabled: true, written: true, traceId, generationId };
  } catch (error) {
    return { enabled: true, written: false, traceId, generationId, error: String(error?.message || error).slice(0, 240) };
  }
}

export function buildLangfuseBatch({ traceId, generationId, promptMessages, rawOutput, analysis, model, tokenUsage, anomaly, context, startedAt, fallbackUsed }) {
  const timestamp = new Date().toISOString();
  const evidence = { anomaly: pickAnomalyEvidence(anomaly), context: pickContextEvidence(context) };
  const generation = {
    id: generationId,
    traceId,
    name: AGENT_NAME,
    model,
    input: promptMessages,
    output: rawOutput,
    metadata: {
      source: "duty-platform-metabase-anomaly-agent",
      parsed_output: analysis,
      evidence,
      fallback_used: fallbackUsed,
      started_at: startedAt.toISOString(),
    },
  };
  if (tokenUsage) {
    generation.promptTokens = tokenUsage.promptTokens;
    generation.completionTokens = tokenUsage.completionTokens;
    generation.totalTokens = tokenUsage.totalTokens;
    generation.usageDetails = { input: tokenUsage.promptTokens, output: tokenUsage.completionTokens, total: tokenUsage.totalTokens, unit: "TOKENS" };
  }
  return {
    batch: [
      {
        id: langfuseId(), timestamp, type: "trace-create",
        body: { id: traceId, name: AGENT_NAME, sessionId: String(context.runId || ""), input: promptMessages, output: analysis, metadata: { source: "duty-platform-metabase-anomaly-agent", evidence, fallback_used: fallbackUsed } },
      },
      { id: langfuseId(), timestamp, type: "generation-create", body: generation },
    ],
  };
}

function getLangfuseSettings(env) {
  const enabledValue = String(env.METABASE_ANOMALY_LANGFUSE_ENABLED || env.LANGFUSE_ENABLED || "").trim().toLowerCase();
  const baseUrl = String(env.METABASE_ANOMALY_LANGFUSE_BASE_URL || env.LANGFUSE_BASE_URL || "").trim().replace(/\/+$/, "");
  const publicKey = String(env.METABASE_ANOMALY_LANGFUSE_PUBLIC_KEY || env.LANGFUSE_PUBLIC_KEY || "").trim();
  const secretKey = String(env.METABASE_ANOMALY_LANGFUSE_SECRET_KEY || env.LANGFUSE_SECRET_KEY || "").trim();
  const explicitlyDisabled = ["0", "false", "off", "no"].includes(enabledValue);
  const configured = Boolean(baseUrl && publicKey && secretKey);
  return { enabled: !explicitlyDisabled && configured, baseUrl, publicKey, secretKey, reason: configured ? "disabled" : "Langfuse 未配置" };
}

function resolveChatCompletionsUrl(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

function systemPrompt() {
  return [
    "你是 Metabase 数据巡检异常分析助手。",
    "只能根据提供的巡检证据推断，不得编造 SQL、表名、数据值、运行状态或已执行的修复。",
    "输出必须是 JSON 对象，字段为 summary、possibleCauses、verificationSteps、recommendedActions、confidence、limitations。",
    "possibleCauses、verificationSteps、recommendedActions 都是字符串数组，最多 3 条；confidence 为 low、medium 或 high。",
    "若证据仅表明查询失败或无数据，要明确说明无法判断业务数据是否异常，并优先给出连接、权限、筛选条件或刷新状态的核查步骤。",
  ].join("\n");
}

function buildEvidencePrompt(anomaly, context) {
  return `请分析以下 Metabase 巡检异常。\n证据：\n${JSON.stringify({ anomaly: pickAnomalyEvidence(anomaly), run: pickContextEvidence(context), sameDashboardAnomalies: (context.sameDashboardAnomalies || []).slice(0, 5).map(pickAnomalyEvidence) }, null, 2)}`;
}

function pickAnomalyEvidence(anomaly = {}) {
  return {
    dashboardTitle: anomaly.dashboardTitle || "",
    dashboardUuid: anomaly.dashboardUuid || "",
    dashboardUrl: anomaly.dashboardUrl || "",
    cardTitle: anomaly.cardTitle || "",
    cardId: anomaly.cardId ?? null,
    dashcardId: anomaly.dashcardId ?? null,
    type: anomaly.type || "",
    message: anomaly.message || "",
    rule: anomaly.rule || null,
  };
}

function pickContextEvidence(context = {}) {
  return {
    runId: context.runId || "",
    startedAt: context.startedAt || "",
    countryCode: context.countryCode || "",
    countryName: context.countryName || "",
    anomalyIndex: Number.isInteger(Number(context.anomalyIndex)) ? Number(context.anomalyIndex) : null,
  };
}

function extractModelContent(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.output?.[0]?.content?.[0]?.text ?? payload?.output_text ?? "";
  return Array.isArray(content) ? content.map((item) => item?.text || item?.content || "").join("\n") : String(content || "");
}

function parseAnalysisOrFallback(rawOutput) {
  const normalized = String(rawOutput || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  try {
    return { value: JSON.parse(normalized), fallbackUsed: false };
  } catch {
    return {
      fallbackUsed: true,
      value: {
        summary: "模型未返回可解析的结构化分析，请结合原始异常信息人工核查。",
        possibleCauses: [], verificationSteps: ["查看巡检历史中的原始异常消息、当前值和基准值。"], recommendedActions: ["修正模型输出格式后重新分析。"], confidence: "low",
        limitations: "模型输出格式异常，未使用其文本内容推断原因。",
      },
    };
  }
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = numberOrZero(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens);
  const completionTokens = numberOrZero(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens);
  const totalCandidate = usage.total_tokens ?? usage.totalTokens;
  if (promptTokens === null && completionTokens === null && totalCandidate == null) return null;
  return { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0, totalTokens: numberOrZero(totalCandidate) ?? ((promptTokens ?? 0) + (completionTokens ?? 0)) };
}

function numberOrZero(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export function normalizeMetabaseAnomalyAnalysis(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    summary: text(source.summary, "模型未给出摘要。"),
    possibleCauses: textList(source.possibleCauses),
    verificationSteps: textList(source.verificationSteps),
    recommendedActions: textList(source.recommendedActions),
    confidence: ["low", "medium", "high"].includes(source.confidence) ? source.confidence : "low",
    limitations: text(source.limitations, "仅基于巡检记录分析，未直接查询 Metabase、数据仓库或调度系统。"),
    dataSideVerdict: ["data_issue", "business_change", "verified_normal", "insufficient_evidence"].includes(source.dataSideVerdict)
      ? source.dataSideVerdict
      : "insufficient_evidence",
    notificationAction: ["send", "downgrade", "enrich_only"].includes(source.notificationAction)
      ? source.notificationAction
      : "enrich_only",
    // Visibility is deliberately independent from the verdict: unknown, pending,
    // or malformed model output must keep the original anomaly visible.
    chartVisibility: source.chartVisibility === "hide_verified_normal"
      ? "hide_verified_normal"
      : "show",
    verificationReason: source.chartVisibility === "hide_verified_normal"
      ? text(source.verificationReason, "")
      : "",
  };
}

function text(value, fallback) {
  const result = String(value || "").trim();
  return result.slice(0, 1200) || fallback;
}

function textList(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3).map((item) => item.slice(0, 600));
}

function langfuseId() {
  return randomUUID().replace(/-/g, "");
}

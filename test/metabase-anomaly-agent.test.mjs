import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMetabaseAnomaly, getMetabaseAnomalyAgentSettings } from "../src/metabase-anomaly-agent.mjs";

const env = {
  METABASE_ANOMALY_AGENT_BASE_URL: "https://llm.example/v1",
  METABASE_ANOMALY_AGENT_API_KEY: "test-key",
  METABASE_ANOMALY_AGENT_MODEL: "test-model",
};

test("Metabase anomaly agent uses an OpenAI-compatible endpoint and returns structured analysis", async () => {
  let request = null;
  const response = await analyzeMetabaseAnomaly({
    env,
    anomaly: { dashboardTitle: "OKR", cardTitle: "放款漏斗", type: "latestNonZeroToZero", message: "指标从 0.1 降为 0" },
    context: { countryCode: "PH", countryName: "菲律宾", sameDashboardAnomalies: [] },
    fetchFn: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          summary: "放款转化归零。",
          possibleCauses: ["上游放款数据未同步"],
          verificationSteps: ["核查卡片查询结果"],
          recommendedActions: ["确认后重跑数据链路"],
          confidence: "medium",
          limitations: "未直接查询数据源。",
        }) } }] }),
      };
    },
  });

  assert.equal(request.url, "https://llm.example/v1/chat/completions");
  assert.match(request.options.body, /放款漏斗/);
  assert.equal(response.model, "test-model");
  assert.equal(response.analysis.confidence, "medium");
  assert.deepEqual(response.analysis.possibleCauses, ["上游放款数据未同步"]);
});

test("Metabase anomaly agent is disabled without complete configuration", async () => {
  assert.equal(getMetabaseAnomalyAgentSettings({}).enabled, false);
  await assert.rejects(
    () => analyzeMetabaseAnomaly({ anomaly: { message: "test" }, env: {} }),
    (error) => error.statusCode === 503 && /未配置/.test(error.message),
  );
});

test("Metabase anomaly agent delegates to an n8n webhook when configured", async () => {
  let request = null;
  const result = await analyzeMetabaseAnomaly({
    env: {
      METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL: "https://n8n.example/webhook/metabase-anomaly-agent",
      METABASE_ANOMALY_AGENT_N8N_TOKEN: "webhook-token",
    },
    anomaly: { dashboardTitle: "OKR", cardTitle: "转化", message: "指标从 1 降为 0" },
    context: { runId: "run-n8n", countryCode: "PH", sameDashboardAnomalies: [] },
    fetchFn: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          success: true,
          generatedAt: "2026-07-27T00:00:00.000Z",
          model: "qwen3.7-plus",
          analysis: { summary: "归零", possibleCauses: ["数据未同步"], verificationSteps: [], recommendedActions: [], confidence: "medium", limitations: "测试" },
          observability: { enabled: true, written: true, traceId: "trace-1", generationId: "generation-1" },
        }),
      };
    },
  });

  assert.equal(result.provider, "n8n");
  assert.equal(request.url, "https://n8n.example/webhook/metabase-anomaly-agent");
  assert.equal(request.options.headers.Authorization, "Bearer webhook-token");
  assert.match(request.options.body, /run-n8n/);
  assert.equal(result.observability.traceId, "trace-1");
});

test("Metabase anomaly agent accepts an async n8n evidence job without blocking", async () => {
  const result = await analyzeMetabaseAnomaly({
    env: {
      METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL: "https://n8n.example/webhook/metabase-anomaly-evidence-agent",
      METABASE_ANOMALY_AGENT_N8N_ASYNC: "true",
      METABASE_ANOMALY_AGENT_CALLBACK_URL: "https://duty.example/api/metabase-anomaly-analysis/callback",
      METABASE_ANOMALY_AGENT_CALLBACK_TOKEN: "callback-token",
    },
    anomaly: { dashboardTitle: "OKR", cardTitle: "转化", message: "指标从 1 降为 0" },
    context: { runId: "run-n8n", countryCode: "PH", sameDashboardAnomalies: [] },
    fetchFn: async (_url, options) => ({
      ok: true,
      json: async () => ({ accepted: true, jobId: "job-1" }),
      options,
    }),
  });

  assert.equal(result.pending, true);
  assert.equal(result.jobId, "job-1");
});

test("Metabase anomaly agent returns pending when an async n8n job outlives the accept window", async () => {
  let request = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => originalSetTimeout(callback, milliseconds === 2_500 ? 0 : milliseconds, ...args);
  try {
    const result = await analyzeMetabaseAnomaly({
      env: {
        METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL: "https://n8n.example/webhook/metabase-anomaly-evidence-agent",
        METABASE_ANOMALY_AGENT_N8N_ASYNC: "true",
        METABASE_ANOMALY_AGENT_CALLBACK_URL: "https://duty.example/api/metabase-anomaly-analysis/callback",
        METABASE_ANOMALY_AGENT_CALLBACK_TOKEN: "callback-token",
      },
      anomaly: { message: "指标从 1 降为 0" },
      context: { runId: "run-slow", countryCode: "MX" },
      fetchFn: async (_url, options) => {
        request = options;
        await new Promise((resolve) => originalSetTimeout(resolve, 5));
        return { ok: true, json: async () => ({ accepted: true, jobId: "job-slow" }) };
      },
    });
    assert.equal(result.pending, true);
    assert.match(result.jobId, /^[0-9a-f-]{36}$/);
    assert.match(request.body, /"jobId"/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("Metabase anomaly agent returns a safe fallback for non-JSON model responses", async () => {
  const result = await analyzeMetabaseAnomaly({
    env,
    anomaly: { message: "test" },
    fetchFn: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "不是 JSON" } }] }) }),
  });

  assert.equal(result.fallbackUsed, true);
  assert.match(result.analysis.summary, /未返回可解析/);
});

test("Metabase anomaly agent sends a Langfuse trace and generation without exposing credentials", async () => {
  const calls = [];
  const result = await analyzeMetabaseAnomaly({
    env: {
      ...env,
      METABASE_ANOMALY_LANGFUSE_BASE_URL: "https://langfuse.example",
      METABASE_ANOMALY_LANGFUSE_PUBLIC_KEY: "pk-test",
      METABASE_ANOMALY_LANGFUSE_SECRET_KEY: "sk-test",
    },
    anomaly: { dashboardTitle: "OKR", cardTitle: "转化", message: "指标从 1 降为 0" },
    context: { runId: "run-1", countryCode: "PH" },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("chat/completions")) {
        return { ok: true, json: async () => ({ model: "test-model", usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }, choices: [{ message: { content: JSON.stringify({ summary: "归零", possibleCauses: [], verificationSteps: [], recommendedActions: [], confidence: "low", limitations: "测试" }) } }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
  });

  assert.equal(result.observability.written, true);
  assert.match(result.observability.traceId, /^[a-f0-9]{32}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://langfuse.example/api/public/ingestion");
  assert.match(calls[1].options.headers.Authorization, /^Basic /);
  const batch = JSON.parse(calls[1].options.body);
  assert.equal(batch.batch.length, 2);
  assert.equal(batch.batch[0].type, "trace-create");
  assert.equal(batch.batch[1].body.promptTokens, 12);
  assert.equal(batch.batch[1].body.metadata.evidence.context.runId, "run-1");
});

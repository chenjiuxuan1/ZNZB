import assert from "node:assert/strict";
import test from "node:test";
import { QwenAnomalyReasoner } from "../src/qwen-anomaly-reasoner.mjs";

const anomaly = {
  countryCode: "INE",
  countryName: "印尼",
  dashboardTitle: "OKR",
  dashboardUuid: "dash-1",
  cardTitle: "规模",
  cardId: 101,
  dashcardId: 202,
  type: "completeDayChange",
  message: "注册数较昨日下降 40%",
};

test("Qwen reasoner reports unavailable without exposing or inventing an API key", async () => {
  const reasoner = new QwenAnomalyReasoner({
    enabled: true,
    model: "qwen3.6-plus",
    apiKeyEnv: "MISSING_DASHSCOPE_KEY_FOR_TEST",
  }, {
    apiKey: "",
    fetchFn: async () => {
      throw new Error("fetch must not run without an API key");
    },
  });

  const result = await reasoner.analyze({ mode: "plan-suggestion", anomaly });

  assert.equal(result.status, "unavailable");
  assert.equal(result.model, "qwen3.6-plus");
  assert.match(result.reason, /MISSING_DASHSCOPE_KEY_FOR_TEST/);
});

test("Qwen reasoner uses DashScope compatible chat completions and removes unsafe SQL suggestions", async () => {
  const calls = [];
  const reasoner = new QwenAnomalyReasoner({
    enabled: true,
    model: "qwen3.6-plus",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  }, {
    apiKey: "test-only-key",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: "需要查询同星期历史基线",
                likelyCause: "可能是低基数或周末效应",
                lineageHints: ["先确认 DWS 聚合表，再找独立 DWD 明细表"],
                suggestedReadOnlySql: [
                  "SELECT * FROM dws.metric_d LIMIT 10",
                  "DELETE FROM dws.metric_d",
                ],
                recommendation: "unverified",
                confidence: 0.7,
                warnings: ["表名仅是假设，需要代码血缘确认"],
              }),
            },
          }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 80,
            total_tokens: 200,
          },
        }),
      };
    },
  });

  const result = await reasoner.analyze({ mode: "plan-suggestion", anomaly });

  assert.equal(result.status, "completed");
  assert.equal(result.model, "qwen3.6-plus");
  assert.deepEqual(result.suggestedReadOnlySql, ["SELECT * FROM dws.metric_d LIMIT 10"]);
  assert.equal(result.recommendation, "unverified");
  assert.equal(result.usage.totalTokens, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.model, "qwen3.6-plus");
  assert.match(request.messages[0].content, /不拥有最终判定权/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-only-key");
});

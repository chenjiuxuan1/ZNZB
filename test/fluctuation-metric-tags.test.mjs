import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFluctuationMetricTagIdentity,
  collectFluctuationMetricTagIdentities,
  createFluctuationMetricTagStore,
  metricTagKey,
} from "../src/fluctuation-metric-tags.mjs";

test("hourly anomaly points share one stable fluctuation metric tag identity", () => {
  const run = {
    runs: [{
      countryCode: "TH",
      countryName: "泰国",
      result: {
        anomalies: [
          { type: "intradaySameTimeChange", dashboardTitle: "每小时监控", dashboardUrl: "https://data.example/th", cardTitle: "放款", message: "指标「放款数」(APP=TH001) 从 10 到 0，统计日期 2026-08-04 09:00" },
          { type: "intradaySameTimeChange", dashboardTitle: "每小时监控", dashboardUrl: "https://data.example/th", cardTitle: "放款", message: "指标「放款数」(APP=TH001) 从 12 到 0，统计日期 2026-08-04 10:00" },
        ],
      },
    }],
  };

  const identities = collectFluctuationMetricTagIdentities(run);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].time_granularity, "hour");
  assert.equal(identities[0].dimension_name, "APP=TH001");
});

test("tag store delegates table initialization, lookup, and tag update to the n8n gateway", async () => {
  const calls = [];
  const identity = buildFluctuationMetricTagIdentity({
    type: "completeDayChange",
    countryName: "墨西哥",
    dashboardTitle: "业务概览",
    dashboardUrl: "https://data.example/mx",
    cardTitle: "转化漏斗",
    message: "完整日指标「通过数」(用户类型=新客) 从 10 到 20",
  });
  const store = createFluctuationMetricTagStore({
    env: { FLUCTUATION_TAG_GATEWAY_WEBHOOK_URL: "https://n8n.example/webhook/fluctuation-metric-tags" },
    requestFn: async (payload) => {
      calls.push(payload);
      if (payload.action === "lookup") return { success: true, tags: { [metricTagKey(identity)]: "三级" } };
      return { success: true, inserted: payload.items?.length || 0 };
    },
  });

  await store.ensureIdentities([identity]);
  const tags = await store.getTags([identity]);
  await store.updateTag(identity, "一级");

  assert.deepEqual(calls.map((item) => item.action), ["ensure", "lookup", "update"]);
  assert.equal(calls[0].items.length, 1);
  assert.equal(tags.tags[metricTagKey(identity)], "三级");
  assert.equal(calls.at(-1).tag, "一级");
});

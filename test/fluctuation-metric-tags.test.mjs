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

test("tag store creates the warning_rule table and preserves the default tag on insert", async () => {
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
    env: { FLUCTUATION_TAG_DB_HOST: "db", FLUCTUATION_TAG_DB_USER: "writer" },
    queryFn: async (sql) => {
      calls.push(sql);
      if (/^SELECT/i.test(sql.trim())) return [{ ...identity, tag: "三级" }];
      return [];
    },
  });

  await store.ensureIdentities([identity]);
  const tags = await store.getTags([identity]);
  await store.updateTag(identity, "一级");

  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS warning_rule\.fluctuation_metric_tags/);
  assert.match(calls[1], /INSERT INTO warning_rule\.fluctuation_metric_tags/);
  assert.equal(tags.tags[metricTagKey(identity)], "三级");
  assert.match(calls.at(-1), /UPDATE warning_rule\.fluctuation_metric_tags SET tag/);
});

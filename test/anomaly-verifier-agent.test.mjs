import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AnomalyVerifierAgent,
  VERIFICATION_STATUS,
  renderSqlTemplate,
} from "../src/anomaly-verifier-agent.mjs";
import { createPlatformApi } from "../src/platform-api.mjs";

const candidate = {
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

function verifierConfig(overrides = {}) {
  return {
    enabled: true,
    minFalsePositiveConfidence: 0.85,
    plans: [
      {
        id: "ine-okr-scale",
        match: {
          countryCode: "INE",
          dashboardTitle: "OKR",
          cardTitle: "规模",
          type: "completeDayChange",
        },
        route: "id",
        sourceTables: ["dws.okr_scale_d", "dwd.registration_detail_d"],
        schemaSql: ["DESC dws.okr_scale_d"],
        verificationSql: "SELECT {{countryCode}} AS country_code",
      },
    ],
    ...overrides,
  };
}

test("anomaly verifier suppresses only high-confidence false positives", async () => {
  const calls = [];
  const agent = new AnomalyVerifierAgent({
    config: verifierConfig(),
    executeSql: async (request) => {
      calls.push(request);
      if (request.purpose === "anomaly-lineage-schema-check") {
        return { rows: [{ Field: "stat_date" }], traceId: "schema-trace" };
      }
      return {
        rows: [{
          verdict: "normal",
          confidence: 0.96,
          source_complete: true,
          is_anomaly: false,
          data_quality_issue: false,
          observed_value: 980,
          baseline_low: 900,
          baseline_high: 1100,
          reason: "独立明细表重算结果位于同星期历史区间内",
        }],
        traceId: "verify-trace",
      };
    },
    now: () => new Date("2026-07-24T08:00:00.000Z"),
  });

  const result = await agent.verifyResult({
    checkedAt: "2026-07-24T07:50:00.000Z",
    anomalyCount: 2,
    anomalies: [
      candidate,
      { ...candidate, cardTitle: "日期完整性", type: "requiredDatePresent" },
    ],
  });

  assert.equal(result.originalAnomalyCount, 2);
  assert.equal(result.anomalyCount, 1);
  assert.equal(result.suppressedAnomalyCount, 1);
  assert.equal(result.suppressedAnomalies[0].verificationStatus, VERIFICATION_STATUS.FALSE_POSITIVE);
  assert.equal(result.suppressedAnomalies[0].finalStatus, "normal");
  assert.equal(result.verification.falsePositiveCount, 1);
  assert.equal(result.verification.unverifiedCount, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sql, "SELECT 'INE' AS country_code");
  assert.equal(result.verification.records[0].evidence.queries[1].traceId, "verify-trace");
  assert.equal(Object.prototype.hasOwnProperty.call(result.verification.records[0].evidence.queries[1], "sql"), false);
});

test("anomaly verifier keeps low-confidence normal conclusions as unverified", async () => {
  const agent = new AnomalyVerifierAgent({
    config: verifierConfig(),
    executeSql: async () => ({
      rows: [{
        verdict: "normal",
        confidence: 0.6,
        source_complete: true,
        reason: "样本不足",
      }],
    }),
  });

  const result = await agent.verifyResult({ anomalyCount: 1, anomalies: [candidate] });

  assert.equal(result.anomalyCount, 1);
  assert.equal(result.suppressedAnomalyCount, 0);
  assert.equal(result.anomalies[0].verificationStatus, VERIFICATION_STATUS.UNVERIFIED);
  assert.match(result.anomalies[0].verificationReason, /低于门槛/);
});

test("anomaly verifier preserves candidates when lineage is missing or data quality is broken", async () => {
  const noPlanAgent = new AnomalyVerifierAgent({
    config: verifierConfig({ plans: [] }),
    executeSql: async () => {
      throw new Error("should not execute");
    },
  });
  const noPlanResult = await noPlanAgent.verifyResult({ anomalyCount: 1, anomalies: [candidate] });
  assert.equal(noPlanResult.anomalies[0].verificationStatus, VERIFICATION_STATUS.UNVERIFIED);
  assert.match(noPlanResult.anomalies[0].verificationReason, /没有匹配/);

  const dataIssueAgent = new AnomalyVerifierAgent({
    config: verifierConfig(),
    executeSql: async () => ({
      rows: [{
        verdict: "data_quality_issue",
        confidence: 0.99,
        source_complete: false,
        data_quality_issue: true,
        reason: "DWD 最新分区尚未产出",
      }],
    }),
  });
  const dataIssueResult = await dataIssueAgent.verifyResult({ anomalyCount: 1, anomalies: [candidate] });
  assert.equal(dataIssueResult.anomalyCount, 1);
  assert.equal(dataIssueResult.anomalies[0].verificationStatus, VERIFICATION_STATUS.DATA_QUALITY_ISSUE);
  assert.equal(dataIssueResult.verification.dataQualityIssueCount, 1);
});

test("verification SQL templates escape anomaly values as SQL literals", () => {
  const rendered = renderSqlTemplate(
    "SELECT {{countryCode}} AS country_code, {{cardTitle}} AS card_title",
    { countryCode: "INE", cardTitle: "O'Reilly" },
  );
  assert.equal(rendered, "SELECT 'INE' AS country_code, 'O''Reilly' AS card_title");
  assert.throws(
    () => renderSqlTemplate("SELECT {{rawTable}}", candidate),
    /Unsupported verification SQL template variable/,
  );
});

test("platform API exposes manual anomaly verification with an injected read-only executor", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "anomaly-verifier-platform-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "config/anomaly-verifier.config.json"),
    JSON.stringify(verifierConfig()),
  );

  const api = createPlatformApi({
    rootDir,
    anomalyVerificationExecuteFn: async () => ({
      rows: [{
        verdict: "normal",
        confidence: 0.99,
        source_complete: true,
        is_anomaly: false,
        reason: "数据库重算正常",
      }],
      traceId: "manual-trace",
    }),
  });

  const result = await api.verifyAnomalies({
    result: { checkedAt: "2026-07-24T08:00:00.000Z", anomalyCount: 1, anomalies: [candidate] },
  });

  assert.equal(result.anomalyCount, 0);
  assert.equal(result.suppressedAnomalyCount, 1);
  assert.equal(result.verification.status, "completed");
});

test("Qwen analysis is advisory and cannot override the deterministic database verdict", async () => {
  const reasonerCalls = [];
  const agent = new AnomalyVerifierAgent({
    config: verifierConfig({
      llm: {
        enabled: true,
        model: "qwen3.6-plus",
      },
    }),
    executeSql: async () => ({
      rows: [{
        verdict: "confirmed_anomaly",
        confidence: 0.98,
        source_complete: true,
        is_anomaly: true,
        reason: "独立明细重算仍超出历史上界",
      }],
    }),
    reasoner: {
      analyze: async (input) => {
        reasonerCalls.push(input);
        return {
          enabled: true,
          status: "completed",
          model: "qwen3.6-plus",
          summary: "模型认为可能是正常活动影响",
          recommendation: "false_positive",
          confidence: 0.99,
        };
      },
    },
  });

  const result = await agent.verifyResult({ anomalyCount: 1, anomalies: [candidate] });

  assert.equal(result.anomalyCount, 1);
  assert.equal(result.suppressedAnomalyCount, 0);
  assert.equal(result.anomalies[0].verificationStatus, VERIFICATION_STATUS.CONFIRMED_ANOMALY);
  assert.equal(result.anomalies[0].llmAnalysisSummary, "模型认为可能是正常活动影响");
  assert.equal(result.verification.llm.model, "qwen3.6-plus");
  assert.equal(result.verification.llm.completedCount, 1);
  assert.equal(reasonerCalls.length, 1);
  assert.equal(reasonerCalls[0].mode, "evidence-review");
});

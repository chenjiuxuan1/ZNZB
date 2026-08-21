import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildDailyUsage,
  buildCountryUsage,
  normalizeAuditRow,
  normalizeUsageConfig,
  fetchAndAggregateUsage,
  saveUsageSnapshot,
} from "../src/ds-scheduler-usage.mjs";

const SAMPLE_ROWS = [
  { operation_time: "2026-08-20 09:00:00", operator: "张三", source_system: "codex-skill", country: "cn", action: "list_projects", success: 1, risk_level: "low", duration_ms: 120, token: "TOK-CN" },
  { operation_time: "2026-08-20 10:00:00", operator: "张三", source_system: "codex-skill", country: "cn", action: "create_workflow", success: 0, risk_level: "medium", duration_ms: 900, error_code: "ERR" },
  { operation_time: "2026-08-20 11:00:00", operator: "李四", source_system: "n8n", country: "ine", action: "list_workflows", success: 1, risk_level: "low", duration_ms: 50 },
  { operation_time: "2026-08-21 09:00:00", operator: "张三", source_system: "codex-skill", country: "pk", action: "offline_schedule", success: 1, risk_level: "high", duration_ms: 300 },
];

test("buildDailyUsage aggregates totals and per-operator stats by day", () => {
  const report = buildDailyUsage(SAMPLE_ROWS);
  assert.equal(report.dayCount, 2);
  assert.equal(report.totalRequests, 4);
  assert.equal(report.totalSuccess, 3);
  assert.equal(report.totalFailed, 1);
  assert.equal(report.totalRiskActions, 2);
  assert.equal(report.totalSuccessRate, 75);
  assert.equal(report.uniqueOperators, 2);

  const day1 = report.days.find((d) => d.date === "2026-08-20");
  assert.equal(day1.requests, 3);
  assert.equal(day1.uniqueOperators, 2);
  assert.equal(day1.successRate, 66.7);

  const zhang = day1.operators.find((o) => o.operator === "张三");
  assert.equal(zhang.requests, 2);
  assert.equal(zhang.success, 1);
  assert.equal(zhang.failed, 1);
  assert.equal(zhang.riskActions, 1);
  assert.deepEqual(zhang.actions, { list_projects: 1, create_workflow: 1 });
  assert.equal(zhang.maxDurationMs, 900);
  assert.equal(zhang.avgDurationMs, 510);
});

test("buildDailyUsage orders operators by request count and exposes country breakdown", () => {
  const report = buildDailyUsage(SAMPLE_ROWS);
  const day1 = report.days.find((d) => d.date === "2026-08-20");
  assert.equal(day1.operators[0].operator, "张三");
  assert.deepEqual(day1.countries, { cn: 2, ine: 1 });
});

test("buildCountryUsage aggregates per-country totals and per-day windows", () => {
  const normalized = SAMPLE_ROWS.map(normalizeAuditRow);
  const countries = buildCountryUsage(normalized);
  const cn = countries.find((c) => c.country === "cn");
  assert.ok(cn);
  assert.equal(cn.requests, 2);
  assert.equal(cn.success, 1);
  assert.equal(cn.failed, 1);
  assert.equal(cn.successRate, 50);
  assert.equal(cn.riskActions, 1);
  // 以 token 为主聚合：TOK-CN + 无 token 的 "-"
  assert.equal(cn.uniqueOperators, 2);
  const cnTok = cn.operators.find((o) => o.token === "TOK-CN");
  assert.ok(cnTok);
  assert.deepEqual(cnTok.tools, ["张三"]);
  const cnNoTok = cn.operators.find((o) => o.token === "-");
  assert.ok(cnNoTok);
  assert.deepEqual(cnNoTok.tools, ["张三"]);
  // per-day window: last 1 day for cn covers 2026-08-20 (2 requests)
  const windowed = cn.daily.slice(-1);
  assert.equal(windowed.reduce((s, d) => s + d.requests, 0), 2);
  assert.deepEqual(cn.actions, { list_projects: 1, create_workflow: 1 });
  assert.equal(countries[0].requests >= countries[countries.length - 1].requests, true);
  assert.deepEqual(cn.tokens, ["TOK-CN"]);
  assert.deepEqual(cnTok.actions, { list_projects: 1 });
});

test("normalizeAuditRow maps token from row or ds_token", () => {
  assert.equal(normalizeAuditRow({ operation_time: "2026-08-20", operator: "A", token: "T1" }).token, "T1");
  assert.equal(normalizeAuditRow({ operation_time: "2026-08-20", operator: "A", ds_token: "T2" }).token, "T2");
  assert.equal(normalizeAuditRow({ operation_time: "2026-08-20", operator: "A" }).token, "");
});

test("normalizeAuditRow handles success booleans/ints and derives date", () => {
  assert.equal(normalizeAuditRow({ operation_time: "2026-08-20 12:34:56", operator: "A", success: 1 }).date, "2026-08-20");
  assert.equal(normalizeAuditRow({ operation_time: "2026-08-20", success: true }).success, true);
  assert.equal(normalizeAuditRow({}).operator, "unknown");
  assert.equal(normalizeAuditRow({ operation_time: "x" }).date, null);
});

test("normalizeUsageConfig clamps days and resolves env strings", () => {
  process.env.DS_AUDIT_DB_PASSWORD = "secret";
  const cfg = normalizeUsageConfig({ source: "SSH", days: 9999, auditDb: { password: "${DS_AUDIT_DB_PASSWORD}" } });
  assert.equal(cfg.source, "ssh");
  assert.equal(cfg.days, 90);
  assert.equal(cfg.auditDb.password, "secret");
  delete process.env.DS_AUDIT_DB_PASSWORD;
});

test("fetchAndAggregateUsage builds report from snapshot rows", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsu-test-"));
  try {
    await saveUsageSnapshot(rootDir, { generatedAt: new Date().toISOString(), rows: SAMPLE_ROWS });
    const report = await fetchAndAggregateUsage({
      rootDir,
      config: { enabled: true, source: "snapshot", days: 30 },
    });
    assert.equal(report.totalRequests, 4);
    assert.equal(report.source, "snapshot");
    assert.equal(report.cached, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

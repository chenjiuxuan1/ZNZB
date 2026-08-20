import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildDailyUsage,
  normalizeAuditRow,
  normalizeUsageConfig,
  fetchAndAggregateUsage,
  saveUsageSnapshot,
} from "../src/ds-scheduler-usage.mjs";

const SAMPLE_ROWS = [
  { operation_time: "2026-08-20 09:00:00", operator: "张三", source_system: "codex-skill", country: "cn", action: "list_projects", success: 1, risk_level: "low", duration_ms: 120 },
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkAllHiveCountries, loadHiveSchedulerConfig, parseHiveProjectNames } from "../src/hive-scheduler-monitor.mjs";

test("HIVE project names accept common separators and remove duplicates", () => {
  assert.deepEqual(parseHiveProjectNames("DW_DM，DW_ADS; DW_DM\nDW_DWD"), ["DW_DM", "DW_ADS", "DW_DWD"]);
});

test("HIVE config preloads the requested China Indonesia and Thailand project ranges", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-default-projects-"));
  await fs.mkdir(path.join(rootDir, "config"));
  await fs.writeFile(path.join(rootDir, "config/hive-scheduler.config.json"), JSON.stringify({ projectNames: { cn: "", ine: "", th: "" } }));
  const config = await loadHiveSchedulerConfig(rootDir);
  assert.deepEqual(parseHiveProjectNames(config.projectNames.ine), ["ods", "dwb", "tdm", "dm_feature", "temp", "market", "dwd", "rpt", "dws", "privacy", "dim"]);
  assert.deepEqual(parseHiveProjectNames(config.projectNames.th).slice(-2), ["dim", "dwt"]);
  assert.deepEqual(parseHiveProjectNames(config.projectNames.cn).slice(-3), ["dm_n", "ext", "dwt"]);
});

test("HIVE patrol checks each selected project exactly once with today-due policy", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        data: {
          checked_workflows: [{ workflow_code: "daily", workflow_name: "每日任务" }],
          not_run_workflows: [{ workflow_code: "missing", workflow_name: "未运行任务" }],
          abnormal_workflows: [{ workflow_code: "failed", workflow_name: "失败任务", instance_state: "FAILURE" }],
        },
      }),
    };
  };
  try {
    const result = await checkAllHiveCountries(null, {
      n8nWebhookUrl: "https://gateway.example/hive",
      countries: { mx: { name: "墨西哥", enabled: true, token: "token" }, cn: { name: "中国", enabled: false, token: "token" } },
      projects: { mx: [{ name: "DW_DM", code: "1001" }, { name: "DW_ADS", code: "1002" }] },
    });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.action === "check_failed_instances"));
    assert.ok(requests.every((request) => request.payload.monitor_policy === "scheduled_today_once"));
    assert.ok(requests.every((request) => request.payload.schedule_scope === "today_due"));
    assert.ok(requests.every((request) => !("consecutive_failures" in request.payload)));
    assert.equal(result.totalChecked, 2);
    assert.equal(result.totalNotRun, 2);
    assert.equal(result.totalAbnormal, 2);
    assert.deepEqual(result.countries.map((item) => item.country), ["mx"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

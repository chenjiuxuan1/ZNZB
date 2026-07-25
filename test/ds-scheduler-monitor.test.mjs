import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkAllCountries, loadDsSchedulerConfig, parseProjectNames, saveDsSchedulerConfig } from "../src/ds-scheduler-monitor.mjs";

test("DS project names accept common separators and remove duplicates", () => {
  assert.deepEqual(
    parseProjectNames("数据平台，催收平台; 风控平台\n数据平台"),
    ["数据平台", "催收平台", "风控平台"],
  );
});

test("DS project code can be configured directly without name resolution", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const saved = await saveDsSchedulerConfig(rootDir, {
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { ine: { name: "印尼", token: "token" } },
    projectNames: { ine: "data-platform" },
    projectCodes: { ine: "123456" },
    alerts: { channel: "tv", botId: "metabase-bot" },
  });
  const loaded = await loadDsSchedulerConfig(rootDir);

  assert.equal(saved.projectCodes.ine, "123456");
  assert.equal(saved.resolveErrors.length, 0);
  assert.equal(loaded.projectCodes.ine, "123456");
  assert.equal(loaded.alerts.botId, "metabase-bot");
});

test("DS project details preserve multiple explicitly configured projects", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-multiple-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const saved = await saveDsSchedulerConfig(rootDir, {
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { ine: { name: "印尼", token: "token" } },
    projectNames: { ine: "数据平台，催收平台" },
    projects: {
      ine: [
        { name: "数据平台", code: "1001" },
        { name: "催收平台", code: "1002" },
      ],
    },
  });

  assert.deepEqual(saved.projects.ine, [
    { name: "数据平台", code: "1001", error: "" },
    { name: "催收平台", code: "1002", error: "" },
  ]);
  assert.equal(saved.projectCodes.ine, "1001");
});

test("DS checks every configured project and aggregates partial failures", async () => {
  const originalFetch = globalThis.fetch;
  const requestedCodes = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestedCodes.push(request.payload.project_code);
    const failed = request.payload.project_code === "1002";
    return {
      async text() {
        return JSON.stringify(failed
          ? { success: false, error: { message: "project unavailable" } }
          : { success: true, data: { total_checked: 3, stuck_count: 1, stale_count: 0, stuck_workflows: [] } });
      },
    };
  };
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "https://gateway.example/ds",
      countries: { ine: { name: "印尼", token: "token" } },
      projects: { ine: [{ name: "数据平台", code: "1001" }, { name: "催收平台", code: "1002" }] },
    });

    assert.deepEqual(requestedCodes, ["1001", "1002"]);
    assert.equal(result.countries[0].success, true);
    assert.equal(result.countries[0].partialFailure, true);
    assert.equal(result.countries[0].checkedWorkflows, 3);
    assert.equal(result.countries[0].projects.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

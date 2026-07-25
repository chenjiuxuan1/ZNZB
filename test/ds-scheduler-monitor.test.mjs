import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkAllCountries, loadDsSchedulerConfig, parseProjectNames, resolveDsWebhookUrl, resolveProjectName, saveDsSchedulerConfig } from "../src/ds-scheduler-monitor.mjs";

test("DS project names accept common separators and remove duplicates", () => {
  assert.deepEqual(
    parseProjectNames("数据平台，催收平台; 风控平台\n数据平台"),
    ["数据平台", "催收平台", "风控平台"],
  );
});

test("DS webhook URL defaults to the local n8n gateway when unset", () => {
  assert.equal(resolveDsWebhookUrl(""), "http://127.0.0.1:5678/webhook/ds-scheduler");
  assert.equal(resolveDsWebhookUrl(undefined), "http://127.0.0.1:5678/webhook/ds-scheduler");
  assert.equal(resolveDsWebhookUrl("https://remote.example/ds"), "https://remote.example/ds");
});

test("DS webhook URL honors the DS_SCHEDULER_WEBHOOK_URL env override", () => {
  const previous = process.env.DS_SCHEDULER_WEBHOOK_URL;
  process.env.DS_SCHEDULER_WEBHOOK_URL = "https://env-n8n.example/webhook/ds";
  try {
    assert.equal(resolveDsWebhookUrl(""), "https://env-n8n.example/webhook/ds");
    assert.equal(resolveDsWebhookUrl(undefined), "https://env-n8n.example/webhook/ds");
  } finally {
    if (previous === undefined) {
      delete process.env.DS_SCHEDULER_WEBHOOK_URL;
    } else {
      process.env.DS_SCHEDULER_WEBHOOK_URL = previous;
    }
  }
});

test("DS webhook URL interpolates env placeholders like wattrel", () => {
  const previous = process.env.DS_SCHEDULER_WEBHOOK_URL;
  process.env.DS_SCHEDULER_WEBHOOK_URL = "https://placeholder.example/webhook/ds";
  try {
    assert.equal(resolveDsWebhookUrl("${DS_SCHEDULER_WEBHOOK_URL}"), "https://placeholder.example/webhook/ds");
  } finally {
    if (previous === undefined) {
      delete process.env.DS_SCHEDULER_WEBHOOK_URL;
    } else {
      process.env.DS_SCHEDULER_WEBHOOK_URL = previous;
    }
  }
});

test("loadDsSchedulerConfig returns the local n8n default when no config file exists", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-default-"));
  const config = await loadDsSchedulerConfig(rootDir);
  assert.equal(config.n8nWebhookUrl, "http://127.0.0.1:5678/webhook/ds-scheduler");
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

test("DS resolveProjectName reports a friendly 403 gateway error instead of raw HTML", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 403,
    ok: false,
    async text() {
      return "<!-- 403 Forbidden --><html><head><title>403 Forbidden</title></head><body>Please confirm you are accessing from the company network</body></html>";
    },
  });
  try {
    const result = await resolveProjectName("https://gateway.example/ds", "cn", "token", "数据平台");
    assert.equal(result.success, false);
    assert.equal(result.error, "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS config save records a friendly error when the gateway returns 403", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 403,
    ok: false,
    async text() {
      return "<!-- 403 Forbidden --><html><body>Forbidden</body></html>";
    },
  });
  try {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-403-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    const saved = await saveDsSchedulerConfig(rootDir, {
      n8nWebhookUrl: "https://gateway.example/ds",
      countries: { cn: { name: "中国", token: "token" } },
      projectNames: { cn: "数据平台" },
    });
    assert.equal(saved.resolveErrors.length, 1);
    assert.equal(saved.resolveErrors[0].country, "cn");
    assert.equal(saved.resolveErrors[0].error, "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单");
    assert.ok(!saved.resolveErrors[0].error.includes("invalid JSON"));
    assert.ok(!saved.resolveErrors[0].error.includes("<html"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

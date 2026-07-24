import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDsSchedulerConfig, saveDsSchedulerConfig } from "../src/ds-scheduler-monitor.mjs";

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

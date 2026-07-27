import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDsSchedulerConfig } from "../src/ds-scheduler-monitor.mjs";

test("DS scheduler uses the local n8n gateway when config is missing", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-config-"));

  const config = await loadDsSchedulerConfig(rootDir);

  assert.deepEqual(config, {
    n8nWebhookUrl: "http://127.0.0.1:5678/webhook/ds-scheduler",
    countries: {},
    projectCodes: {},
    projectNames: {},
  });
});

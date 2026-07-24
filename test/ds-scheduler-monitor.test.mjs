import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDsSchedulerConfig } from "../src/ds-scheduler-monitor.mjs";

test("DS scheduler treats a missing local config as disabled", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-config-"));

  const config = await loadDsSchedulerConfig(rootDir);

  assert.deepEqual(config, {
    n8nWebhookUrl: "",
    countries: {},
    projectCodes: {},
    projectNames: {},
  });
});

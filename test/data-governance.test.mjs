import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  exportDataGovernance,
  healthDataGovernance,
  runDataGovernanceScan,
} from "../src/data-governance.mjs";

async function fakePiPackage(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "znzb-gov-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "tools"), { recursive: true });
  await fs.writeFile(path.join(root, "tools/gov-tools.mjs"), `
    export const govZombieScan = async (input) => input;
    export const govBakScan = async (input) => input;
    export const govExport = async (input) => input;
  `);
  return root;
}

test("data governance normalizes scan input at its public interface", async (t) => {
  const packageDir = await fakePiPackage(t);
  const result = await runDataGovernanceScan({
    country: "CN",
    layers: ["ods", "invalid", "ods"],
    lookback_days: 999,
    bak: false,
    ignored: "value",
  }, { env: { GOV_PI_PACKAGE_PATH: packageDir } });

  assert.deepEqual(result, { country: "cn", layers: ["ods"], lookback_days: 90, bak: false });
});

test("data governance export cannot override the configured output directory", async (t) => {
  const packageDir = await fakePiPackage(t);
  const outputDir = path.join(packageDir, "safe-output");
  const result = await exportDataGovernance({
    rows: [{ table_name: "example" }],
    format: "csv",
    country: "pk",
    dir: "/tmp/request-controlled",
    name: "report",
  }, { env: { GOV_PI_PACKAGE_PATH: packageDir, GOV_OUTPUT_DIR: outputDir } });

  assert.equal(result.dir, outputDir);
  assert.equal(result.format, "csv");
  assert.equal(result.rowCount, 1);
});

test("data governance health does not expose absolute server paths", async (t) => {
  const packageDir = await fakePiPackage(t);
  const health = healthDataGovernance({ GOV_PI_PACKAGE_PATH: packageDir });
  assert.equal(health.toolsExist, true);
  assert.equal("piPackage" in health, false);
});

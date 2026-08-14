import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { cleanupLegacyDashboardUrls } from "../src/history-dashboard-url-cleanup.mjs";

const execFileAsync = promisify(execFile);

test("history cleanup command supports an explicit check-only mode", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-dashboard-url-command-"));
  const configDir = path.join(rootDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  const resultFile = path.join(configDir, "public-check-result.ready.json");
  const original = { anomalies: [{ dashboardUrl: "https://data.example/public/dashboard/legacy-uuid" }] };
  await fs.writeFile(resultFile, `${JSON.stringify(original, null, 2)}\n`);

  const commandFile = new URL("../scripts/cleanup-legacy-dashboard-urls.mjs", import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [commandFile.pathname, "--check", "--root", rootDir]);
  const report = JSON.parse(stdout);

  assert.equal(report.dryRun, true);
  assert.equal(report.changedFileCount, 1);
  assert.equal(report.removedFieldCount, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(resultFile, "utf8")), original);
});

test("history cleanup dry run reports legacy fields without changing files or creating backups", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-dashboard-url-dry-run-"));
  const configDir = path.join(rootDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  const historyFile = path.join(configDir, "batch-check-run-history.json");
  const original = {
    runs: [{ result: { anomalies: [
      { dashboardUrl: "https://data.example/public/dashboard/legacy-uuid" },
      { dashboardUrl: "https://data.example/dashboard/642" },
    ] } }],
  };
  await fs.writeFile(historyFile, `${JSON.stringify(original, null, 2)}\n`);

  const report = await cleanupLegacyDashboardUrls({
    rootDir,
    dryRun: true,
    timestamp: "dry-run-must-not-create-backup",
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.changedFileCount, 1);
  assert.equal(report.removedFieldCount, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(historyFile, "utf8")), original);
  await assert.rejects(fs.access(path.join(configDir, "history-url-backups")));
});

test("history cleanup backs up changed files and removes only legacy public dashboardUrl fields", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-dashboard-url-cleanup-"));
  const configDir = path.join(rootDir, "config");
  await fs.mkdir(configDir, { recursive: true });

  const resultFile = path.join(configDir, "public-check-result.ready.json");
  const historyFile = path.join(configDir, "batch-check-run-history.json");
  const originalResult = {
    anomalies: [{
      dashboardUrl: "https://data.example/public/dashboard/legacy-uuid?tab=overview",
      publicUrl: "https://data.example/public/dashboard/keep-this-other-field",
    }],
    checkedCards: [{ dashboardUrl: "https://data.example/dashboard/642?date=past1days~" }],
  };
  const originalHistory = {
    runs: [{ result: { anomalies: [{ dashboardUrl: "https://data.example/public/dashboard/another-uuid" }] } }],
  };
  await fs.writeFile(resultFile, `${JSON.stringify(originalResult, null, 2)}\n`);
  await fs.writeFile(historyFile, `${JSON.stringify(originalHistory, null, 2)}\n`);
  await fs.writeFile(path.join(configDir, "unrelated.json"), JSON.stringify({ dashboardUrl: "https://data.example/public/dashboard/untouched" }));

  const report = await cleanupLegacyDashboardUrls({
    rootDir,
    timestamp: "2026-08-13T12-34-56-000Z",
  });

  assert.equal(report.changedFileCount, 2);
  assert.equal(report.removedFieldCount, 2);
  assert.deepEqual(report.files.map((item) => item.file), [
    "batch-check-run-history.json",
    "public-check-result.ready.json",
  ]);

  const cleanedResult = JSON.parse(await fs.readFile(resultFile, "utf8"));
  assert.equal("dashboardUrl" in cleanedResult.anomalies[0], false);
  assert.equal(cleanedResult.anomalies[0].publicUrl, originalResult.anomalies[0].publicUrl);
  assert.equal(cleanedResult.checkedCards[0].dashboardUrl, originalResult.checkedCards[0].dashboardUrl);

  const cleanedHistory = JSON.parse(await fs.readFile(historyFile, "utf8"));
  assert.equal("dashboardUrl" in cleanedHistory.runs[0].result.anomalies[0], false);

  const backupDir = path.join(configDir, "history-url-backups", "2026-08-13T12-34-56-000Z");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(backupDir, path.basename(resultFile)), "utf8")), originalResult);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(backupDir, path.basename(historyFile)), "utf8")), originalHistory);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(configDir, "unrelated.json"), "utf8")).dashboardUrl,
    "https://data.example/public/dashboard/untouched",
  );

  const secondReport = await cleanupLegacyDashboardUrls({
    rootDir,
    timestamp: "2026-08-13T12-35-56-000Z",
  });
  assert.equal(secondReport.changedFileCount, 0);
  assert.equal(secondReport.removedFieldCount, 0);
  await assert.rejects(fs.access(path.join(configDir, "history-url-backups", "2026-08-13T12-35-56-000Z")));
});

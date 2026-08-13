import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const BATCH_HISTORY_FILE = "batch-check-run-history.json";
const PUBLIC_RESULT_FILE = /^public-check-result(?:\..+)?\.json$/;
const LEGACY_PUBLIC_DASHBOARD_URL = /\/public\/dashboard\/[^/?#]+/i;

export async function cleanupLegacyDashboardUrls({
  rootDir = process.cwd(),
  timestamp = formatBackupTimestamp(new Date()),
  dryRun = false,
} = {}) {
  const configDir = path.join(rootDir, "config");
  let entries;
  try {
    entries = await fs.readdir(configDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return emptyReport();
    throw error;
  }

  const fileNames = entries
    .filter((entry) => entry.isFile() && isHistoryResultFile(entry.name))
    .map((entry) => entry.name)
    .sort();
  const report = emptyReport(dryRun);

  for (const fileName of fileNames) {
    const filePath = path.join(configDir, fileName);
    const original = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(original);
    const removedFieldCount = removeLegacyDashboardUrlFields(parsed);
    if (removedFieldCount === 0) continue;

    let backupPath = null;
    if (!dryRun) {
      const backupDir = path.join(configDir, "history-url-backups", timestamp);
      await fs.mkdir(backupDir, { recursive: true });
      backupPath = path.join(backupDir, fileName);
      await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
      await writeJsonAtomic(filePath, parsed);
    }

    report.changedFileCount += 1;
    report.removedFieldCount += removedFieldCount;
    report.files.push({ file: fileName, removedFieldCount, backupPath });
  }

  return report;
}

function removeLegacyDashboardUrlFields(value) {
  if (!value || typeof value !== "object") return 0;
  let removedFieldCount = 0;

  if (!Array.isArray(value)
      && typeof value.dashboardUrl === "string"
      && LEGACY_PUBLIC_DASHBOARD_URL.test(value.dashboardUrl)) {
    delete value.dashboardUrl;
    removedFieldCount += 1;
  }

  for (const child of Object.values(value)) {
    removedFieldCount += removeLegacyDashboardUrlFields(child);
  }
  return removedFieldCount;
}

function isHistoryResultFile(fileName) {
  return fileName === BATCH_HISTORY_FILE || PUBLIC_RESULT_FILE.test(fileName);
}

function formatBackupTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function emptyReport(dryRun = false) {
  return { dryRun, changedFileCount: 0, removedFieldCount: 0, files: [] };
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporaryPath, filePath);
}

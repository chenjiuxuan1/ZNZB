import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const repoUrl = new URL("../", import.meta.url);

test("tracked examples do not contain reusable credentials", async () => {
  const alertRegistry = await fs.readFile(new URL("config/alert-registry.example.json", repoUrl), "utf8");
  const n8nWorkflow = await fs.readFile(new URL("n8n-batch-ready-fixed.json", repoUrl), "utf8");
  const alertTemplates = await Promise.all([
    "config/alert-templates/fin_ods_biz.py.tmpl",
    "config/alert-templates/fin_ods_fin.py.tmpl",
    "config/alert-templates/fin_ods_quality.py.tmpl",
  ].map((file) => fs.readFile(new URL(file, repoUrl), "utf8")));

  assert.doesNotMatch(alertRegistry, /--sr-(?:backup-)?password\s+['"](?!\$\{)[^'"]+['"]/i);
  for (const template of alertTemplates) {
    assert.doesNotMatch(template, /--sr-(?:backup-)?password\s+['"](?!(?:\$\{|\.\.\.))[^'"]+['"]/i);
  }
  assert.doesNotMatch(n8nWorkflow, /Bearer\s+(?!REPLACE_WITH_)[A-Za-z0-9_-]{16,}/);
});

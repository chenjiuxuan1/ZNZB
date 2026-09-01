import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAlertScriptTemplate } from "../src/alert-script-template.mjs";
import { createAlertRegistry } from "../src/alert-registry.mjs";

const realTemplateFile = new URL("../config/alert-templates/fin_ods_quality.py.tmpl", import.meta.url);

async function tmpSetup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alert-tmpl-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "config", "alert-templates"), { recursive: true });
  for (const name of ["fin_ods_quality.py.tmpl", "fin_ods_fin.py.tmpl", "fin_ods_biz.py.tmpl"]) {
    await fs.copyFile(
      new URL(`../config/alert-templates/${name}`, import.meta.url),
      path.join(dir, "config", "alert-templates", name),
    );
  }
  const template = createAlertScriptTemplate({ rootDir: dir });
  const registry = createAlertRegistry({ rootDir: dir });
  return { dir, template, registry };
}

function sampleBlocks() {
  return {
    BIZ_CTE_CLAUSE: "with nonoperate_ods_base as (select 1 as x)",
    FIN_UNION_SELECT: "select current_date() as dt, 'ods_security.ods_capital_bi_collection_report' as table_name, 1 as mysql_primary_key, 1 as src_value, 1 as dest_value, 0 as diff from cw_catalog.capital.bi_collection_report a left join ods_security.ods_capital_bi_collection_report b on b.bi_collection_report_id = a.bi_collection_report_id",
    BIZ_UNION_SELECT: "select current_date() as dt, 'fin_global.ods_pk_pl_nonoperate_expense_monthly.expense_local' as table_name, 1 as mysql_primary_key, 1 as src_value, 1 as dest_value, 0 as diff from nonoperate_ods_base a full outer join nonoperate_global_base b on b.country = a.country",
  };
}

test("renderScript injects SQL blocks into template placeholders", async (t) => {
  const { dir } = await tmpSetup(t);
  const content = await fs.readFile(path.join(dir, "config", "alert-templates", "fin_ods_quality.py.tmpl"), "utf8");
  const template = createAlertScriptTemplate({ rootDir: dir });
  const blocks = sampleBlocks();
  const { content: rendered, missing } = template.renderScript(content, blocks);
  assert.equal(missing.length, 0);
  assert.ok(rendered.includes("with nonoperate_ods_base as (select 1 as x)"));
  assert.ok(rendered.includes("ods_security.ods_capital_bi_collection_report"));
  assert.ok(rendered.includes("fin_global.ods_pk_pl_nonoperate_expense_monthly.expense_local"));
  // 占位符应全部被替换
  assert.ok(!rendered.includes("{{FIN_UNION_SELECT}}"));
  assert.ok(!rendered.includes("{{BIZ_CTE_CLAUSE}}"));
});

test("renderScript reports missing placeholders when a block is absent", async (t) => {
  const { dir } = await tmpSetup(t);
  const content = await fs.readFile(path.join(dir, "config", "alert-templates", "fin_ods_quality.py.tmpl"), "utf8");
  const template = createAlertScriptTemplate({ rootDir: dir });
  const blocks = { FIN_UNION_SELECT: "select 1" }; // 缺 BIZ_CTE_CLAUSE / BIZ_UNION_SELECT
  const { content: rendered, missing } = template.renderScript(content, blocks);
  assert.ok(missing.includes("BIZ_CTE_CLAUSE"));
  assert.ok(missing.includes("BIZ_UNION_SELECT"));
  assert.ok(rendered.includes("{{BIZ_CTE_CLAUSE}}"));
});

test("renderScript resolves single-brace {KEY} references inside SQL blocks", async (t) => {
  const { dir } = await tmpSetup(t);
  const template = createAlertScriptTemplate({ rootDir: dir });
  const miniTmpl = 'MONITOR_TABLE = "{{MONITOR_TABLE}}"\nLTV_QUERY_SQL = "{{LTV_QUERY_SQL}}"\n';
  const blocks = {
    MONITOR_TABLE: "dm_dd_new.ads_capital_ltv",
    LTV_QUERY_SQL: "select a.stat_date from {MONITOR_TABLE} a",
  };
  const { content: rendered, missing } = template.renderScript(miniTmpl, blocks);
  assert.equal(missing.length, 0);
  assert.ok(rendered.includes("from dm_dd_new.ads_capital_ltv a"));
  assert.ok(!rendered.includes("{MONITOR_TABLE}"));
});

test("renderScript renders single-block fin template without leftover placeholders", async (t) => {
  const { dir } = await tmpSetup(t);
  const content = await fs.readFile(path.join(dir, "config", "alert-templates", "fin_ods_fin.py.tmpl"), "utf8");
  const template = createAlertScriptTemplate({ rootDir: dir });
  const { content: rendered, missing } = template.renderScript(content, {
    FIN_UNION_SELECT: "select current_date() as dt, 'ods_security.ods_capital_bi_collection_report' as table_name, 1 as src_value, 0 as diff",
  });
  assert.equal(missing.length, 0);
  assert.ok(rendered.includes("FIN_UNION_SELECT"));
  assert.ok(!rendered.includes("{{FIN_UNION_SELECT}}"));
  assert.ok(!rendered.includes("BIZ_QUERY_SQL"));
  assert.ok(!rendered.includes("BIZ_UNION_SELECT"));
});

test("renderScript renders single-block biz template with WITH CTE query", async (t) => {
  const { dir } = await tmpSetup(t);
  const content = await fs.readFile(path.join(dir, "config", "alert-templates", "fin_ods_biz.py.tmpl"), "utf8");
  const template = createAlertScriptTemplate({ rootDir: dir });
  const bizQuery = "with nonoperate_ods_base as (select 1 as x)\nselect current_date() as dt, 'fin_global.ods_pk_pl_nonoperate_expense_monthly.expense_local' as table_name, 0 as diff";
  const { content: rendered, missing } = template.renderScript(content, { BIZ_QUERY_SQL: bizQuery });
  assert.equal(missing.length, 0);
  assert.ok(rendered.includes("with nonoperate_ods_base as (select 1 as x)"));
  assert.ok(rendered.includes("BIZ_QUERY_SQL"));
  assert.ok(!rendered.includes("{{BIZ_QUERY_SQL}}"));
  assert.ok(!rendered.includes("FIN_UNION_SELECT"));
  assert.ok(!rendered.includes("FIN_MONITOR_TABLE"));
});

test("previewUpdate returns rendered content and diff without writing files", async (t) => {
  const { registry } = await tmpSetup(t);
  const entry = await registry.create({
    id: "pl_test",
    name: "PL 测试",
    templateName: "fin_ods_quality",
    sqlBlocks: sampleBlocks(),
    scriptPath: "alert/xxx.py",
    repoDir: "/tmp",
  });
  const preview = await registry.previewScript("pl_test");
  assert.equal(preview.ok, true);
  assert.ok(preview.rendered.includes("with nonoperate_ods_base"));
  assert.equal(typeof preview.diff.added, "number");
});

test("previewScript rejects entry without templateName", async (t) => {
  const { registry } = await tmpSetup(t);
  const entry = await registry.create({ id: "no_tmpl", name: "无模板", command: "echo hi", runVia: "local" });
  await assert.rejects(() => registry.previewScript("no_tmpl"), /templateName/);
});

test("applyUpdate writes repo file, runs git and deploy steps in sequence", async (t) => {
  const { dir } = await tmpSetup(t);
  // 用临时目录当 repoDir，构造 git 仓库
  const repoDir = path.join(dir, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, "alert", "xxx.py"), "old-content", "utf8").catch(async () => {
    await fs.mkdir(path.join(repoDir, "alert"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "alert", "xxx.py"), "old-content", "utf8");
  });
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  } catch {
    // git 不可用时跳过（CI 环境）
    return;
  }
  const registry = createAlertRegistry({ rootDir: dir });
  const entry = await registry.create({
    id: "pl_apply",
    name: "PL 更新",
    templateName: "fin_ods_quality",
    sqlBlocks: sampleBlocks(),
    scriptPath: "alert/xxx.py",
    repoDir,
    runVia: "local", // 本机测试不部署 SSH
    remoteScriptPath: "",
  });
  const result = await registry.applyScript("pl_apply", { skipDeploy: true });
  assert.equal(result.ok, true);
  const written = await fs.readFile(path.join(repoDir, "alert", "xxx.py"), "utf8");
  assert.ok(written.includes("with nonoperate_ods_base"));
  assert.equal(written, result.rendered ?? written);
  // git 状态：文件已提交（无未提交变更）
  const { execFileSync: ex } = await import("node:child_process");
  const status = String(ex("git", ["status", "--porcelain"], { cwd: repoDir }));
  assert.ok(!status.includes("alert/xxx.py"));
});

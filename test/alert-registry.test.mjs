import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAlertRegistry } from "../src/alert-registry.mjs";

const exampleFile = new URL("../config/alert-registry.example.json", import.meta.url);

test("runtime script audit file is excluded from source control", async () => {
  const gitignore = await fs.readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^config\/alert-script-audit\.json$/m);
});

test("voice configuration responses never expose raw cloud credentials", async (t) => {
  const { registry, dir } = await tmpRegistry(t);
  await fs.mkdir(path.join(dir, "config"), { recursive: true });
  await fs.writeFile(path.join(dir, "config", "mc-voice.json"), JSON.stringify({
    enabled: true,
    accessKeyId: "LTAI-raw-access-key",
    accessKeySecret: "raw-super-secret-value",
    calledShowNumber: "02160556003",
    ttsCode: "TTS_TEST",
  }));

  for (const voice of [await registry.getMcVoice(), await registry.getEntryVoice("mc_cn")]) {
    assert.equal("accessKeySecret" in voice, false);
    assert.equal("accessKeyId" in voice, false);
    assert.match(voice.accessKeyIdMasked, /\*\*\*\*/);
    assert.match(voice.accessKeySecretMasked, /\*\*\*\*/);
    assert.doesNotMatch(JSON.stringify(voice), /raw-super-secret-value|LTAI-raw-access-key/);
  }
});

async function tmpRegistry(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alert-registry-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = createAlertRegistry({ rootDir: dir });
  return { registry, dir };
}

test("seedExamples imports preset PL/MX/ID alert entries", async (t) => {
  const { registry, dir } = await tmpRegistry(t);
  await fs.mkdir(path.join(dir, "config"), { recursive: true });
  await fs.copyFile(exampleFile, path.join(dir, "config", "alert-registry.example.json"));
  const alerts = await registry.seedExamples();
  const ids = alerts.map((item) => item.id);
  assert.ok(ids.includes("pl_fin_consistency"));
  assert.ok(ids.includes("pl_biz_consistency"));
  assert.ok(ids.includes("mx_capital_ltv_chuanjin"));
  assert.ok(ids.includes("id_marketing_dwd_cnt"));
});

test("create/update/remove round-trips and persists to disk", async (t) => {
  const { registry } = await tmpRegistry(t);
  const created = await registry.create({
    name: "测试告警",
    country: "CN",
    sourceType: "custom",
    command: "echo hi",
    runVia: "local",
  });
  assert.ok(created.id);
  assert.equal(created.name, "测试告警");
  const list = await registry.list();
  assert.equal(list.length, 1);

  const updated = await registry.update(created.id, { name: "改名", country: "MX" });
  assert.equal(updated.name, "改名");
  assert.equal(updated.country, "MX");

  const removed = await registry.remove(created.id);
  assert.equal(removed.ok, true);
  assert.equal((await registry.list()).length, 0);
});

test("create rejects duplicate id", async (t) => {
  const { registry } = await tmpRegistry(t);
  await registry.create({ id: "dup", name: "A" });
  await assert.rejects(() => registry.create({ id: "dup", name: "B" }), /已存在/);
});

test("aggregated multi-country history keeps only the entry country", async (t) => {
  const { registry } = await tmpRegistry(t);
  await registry.create({ id: "mc_cn", name: "中国校验", country: "CN" });
  await registry.create({ id: "mc_id", name: "印尼校验", country: "ID" });
  await registry.appendCheckResult({
    id: "run-country-scope",
    checkedAt: "2026-09-08T00:55:12.000Z",
    hasAlert: true,
    countries: [
      { code: "cn", label: "中国", mismatches: [] },
      { code: "id", label: "印尼", mismatches: [{ check_item: "user_flag", mismatch_cnt: 3 }] },
    ],
  });

  const history = await registry.listAllHistory();
  const byEntry = Object.fromEntries(history.map((run) => [run.entryId, run]));
  assert.deepEqual(byEntry.mc_cn.countries.map((item) => item.code), ["cn"]);
  assert.deepEqual(byEntry.mc_id.countries.map((item) => item.code), ["id"]);
  assert.equal(byEntry.mc_cn.hasAlert, false);
  assert.equal(byEntry.mc_id.hasAlert, true);
});

test("normalizeEntry fills defaults and preserves enabled flag", async (t) => {
  const { registry } = await tmpRegistry(t);
  const entry = registry.normalizeEntry({ id: "x", name: "X" });
  assert.equal(entry.country, "");
  assert.equal(entry.sourceType, "custom");
  assert.equal(entry.runVia, "local");
  assert.equal(entry.sshHost, "root@10.20.47.14");
  assert.equal(entry.sshPort, 36000);
  assert.equal(entry.enabled, true);
  const disabled = registry.normalizeEntry({ id: "y", name: "Y", enabled: false });
  assert.equal(disabled.enabled, false);
});

test("runTestByCommand runs local command and captures output", async (t) => {
  const { registry } = await tmpRegistry(t);
  const result = await registry.runTestByCommand({ runVia: "local", command: "echo hello-world" });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello-world/);
});

test("runTestByCommand reports non-zero exit for failing command", async (t) => {
  const { registry } = await tmpRegistry(t);
  const result = await registry.runTestByCommand({ runVia: "local", command: `"${process.execPath}" -e "process.exit(3)"` });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
});

test("runTest runs a stored entry's command", async (t) => {
  const { registry } = await tmpRegistry(t);
  const created = await registry.create({ id: "runme", name: "Run", command: `"${process.execPath}" -e "console.log('out=42')"`, runVia: "local" });
  const result = await registry.runTest(created.id);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /out=42/);
});

test("runTest on missing id rejects with 404", async (t) => {
  const { registry } = await tmpRegistry(t);
  await assert.rejects(() => registry.runTest("nope"), (error) => error.statusCode === 404);
});

test("script audit persists newest-first sanitized operation summaries", async (t) => {
  const { registry } = await tmpRegistry(t);
  await registry.appendScriptAudit({
    entryId: "safe",
    entryName: "Safe",
    action: "publish",
    startedAt: "2026-09-04T01:00:00.000Z",
    finishedAt: "2026-09-04T01:00:02.000Z",
    status: "partial",
    git: { ok: true, stdout: "TOKEN=secret" },
    deploy: { ok: false, stderr: "password=secret" },
    error: "Bearer sensitive-value",
  });
  await registry.appendScriptAudit({
    entryId: "safe",
    entryName: "Safe",
    action: "preview",
    startedAt: "2026-09-04T02:00:00.000Z",
    status: "success",
    diff: { added: 2, removed: 1 },
    rendered: "secret script",
  });

  const audit = await registry.listScriptAudit();
  assert.deepEqual(audit.map((item) => item.action), ["preview", "publish"]);
  assert.equal(audit[0].diff.added, 2);
  assert.deepEqual(audit[1].git, { ok: true });
  assert.deepEqual(audit[1].deploy, { ok: false });
  assert.doesNotMatch(JSON.stringify(audit), /TOKEN=secret|password=secret|sensitive-value|secret script/);
});

test("resolveEnv substitutes ${ENV} placeholders", async (t) => {
  const { registry } = await tmpRegistry(t);
  process.env.AR_TEST_TOKEN = "secret-abc";
  try {
    const resolved = registry.resolveEnv("echo ${AR_TEST_TOKEN}");
    assert.match(resolved, /secret-abc/);
  } finally {
    delete process.env.AR_TEST_TOKEN;
  }
});

test("runTestByCommand with runVia=ssh degrades gracefully when N8N_BASE_URL missing", async (t) => {
  const { registry } = await tmpRegistry(t);
  const previous = process.env.N8N_BASE_URL;
  delete process.env.N8N_BASE_URL;
  try {
    const result = await registry.runTestByCommand({ runVia: "ssh", sshHost: "root@10.20.47.14", sshPort: 36000, command: "echo hi" });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, -1);
    assert.match(result.stderr, /N8N_BASE_URL/);
  } finally {
    if (previous !== undefined) process.env.N8N_BASE_URL = previous;
  }
});

test("runTestByCommand with runVia=ssh forwards command through n8n webhook", async (t) => {
  // mock n8n webhook：接收 {host, port, command}，返回 {code, stdout, stderr}
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, signal: null, stdout: `mock-run:${payload.host}:${payload.port}:${payload.command}`, stderr: "" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { registry } = await tmpRegistry(t);
  const previous = process.env.N8N_BASE_URL;
  process.env.N8N_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const result = await registry.runTestByCommand({ runVia: "ssh", sshHost: "root@10.20.47.14", sshPort: 36000, command: "echo hi" });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^mock-run:root@10\.20\.47\.14:36000:echo hi$/);
  } finally {
    if (previous !== undefined) process.env.N8N_BASE_URL = previous;
    else delete process.env.N8N_BASE_URL;
  }
});

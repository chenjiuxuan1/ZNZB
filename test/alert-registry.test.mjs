import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAlertRegistry } from "../src/alert-registry.mjs";

const exampleFile = new URL("../config/alert-registry.example.json", import.meta.url);

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
  assert.ok(ids.includes("pl_global_consistency"));
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
  const result = await registry.runTestByCommand({ runVia: "local", command: "echo oops; exit 3" });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
});

test("runTest runs a stored entry's command", async (t) => {
  const { registry } = await tmpRegistry(t);
  const created = await registry.create({ id: "runme", name: "Run", command: "printf 'out=%s' 42", runVia: "local" });
  const result = await registry.runTest(created.id);
  assert.equal(result.ok, true);
  assert.match(result.stdout, /out=42/);
});

test("runTest on missing id rejects with 404", async (t) => {
  const { registry } = await tmpRegistry(t);
  await assert.rejects(() => registry.runTest("nope"), (error) => error.statusCode === 404);
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

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("server starts all three patrol schedulers", async () => {
  const source = await fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const startup = source.slice(0, source.indexOf("async function handleApi"));

  assert.equal((startup.match(/startBatchScheduler\(\);/g) || []).length, 1);
  assert.equal((startup.match(/startDsScheduler\(\);/g) || []).length, 1);
  assert.equal((startup.match(/startHiveScheduler\(\);/g) || []).length, 1);
});

test("server exposes the alert script audit read route", async () => {
  const source = await fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /GET" && url\.pathname === "\/api\/alert-registry\/script-audit"/);
  assert.match(source, /alertRegistry\.listScriptAudit\(\)/);
});

test("server exposes a country-scoped multi-country result detail route", async () => {
  const source = await fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('/^\\/api\\/multi-country\\/check-results\\/[^/]+\\/[^/]+$/.test(url.pathname)'));
  assert.match(source, /alertRegistry\.getCheckResultDetail\(runId, country\)/);
});

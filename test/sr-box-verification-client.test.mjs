import assert from "node:assert/strict";
import test from "node:test";
import {
  SrBoxVerificationClient,
  assertReadOnlySql,
  mapCountryToSrRoute,
} from "../src/sr-box-verification-client.mjs";

test("SR Box verifier only accepts a single read-only SQL statement", () => {
  assert.equal(assertReadOnlySql("SELECT 1"), "SELECT 1");
  assert.equal(assertReadOnlySql("WITH source AS (SELECT 1 AS id) SELECT * FROM source"), "WITH source AS (SELECT 1 AS id) SELECT * FROM source");
  assert.equal(assertReadOnlySql("DESC dws.some_table"), "DESC dws.some_table");
  assert.equal(assertReadOnlySql("SHOW CREATE TABLE dws.some_table"), "SHOW CREATE TABLE dws.some_table");
  assert.equal(assertReadOnlySql("SELECT 'drop table prod.x' AS harmless_text"), "SELECT 'drop table prod.x' AS harmless_text");

  assert.throws(() => assertReadOnlySql("DELETE FROM prod.some_table"), /must start|forbidden/i);
  assert.throws(() => assertReadOnlySql("CREATE TABLE testdb.some_table AS SELECT 1"), /must start|forbidden/i);
  assert.throws(() => assertReadOnlySql("SELECT 1; DROP TABLE prod.some_table"), /exactly one/i);
});

test("SR Box verifier maps duty platform country codes to production routes", () => {
  assert.equal(mapCountryToSrRoute("INE"), "id");
  assert.equal(mapCountryToSrRoute("CN"), "cn");
  assert.equal(mapCountryToSrRoute("mx"), "mx");
  assert.throws(() => mapCountryToSrRoute("US"), /Unsupported/);
});

test("SR Box verifier calls the official Python client without a shell", async () => {
  const calls = [];
  const client = new SrBoxVerificationClient({
    pythonExecutable: "/usr/bin/python3",
    scriptPath: "/opt/sr-box/scripts/sr_gateway_client.py",
    timeoutSeconds: 30,
    execFileFn: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: JSON.stringify({
          success: true,
          traceId: "trace-001",
          durationMs: 12,
          data: { rows: [{ verdict: "normal", confidence: 0.95 }] },
        }),
        stderr: "",
      };
    },
  });

  const result = await client.execute({
    country: "INE",
    sql: "SELECT 'normal' AS verdict",
  });

  assert.equal(result.country, "id");
  assert.equal(result.traceId, "trace-001");
  assert.deepEqual(result.rows, [{ verdict: "normal", confidence: 0.95 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/python3");
  assert.ok(calls[0].args.includes("/opt/sr-box/scripts/sr_gateway_client.py"));
  assert.ok(calls[0].args.includes("id"));
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options, "shell"), false);
});

test("SR Box verifier defaults to the runtime bundled with the duty platform", () => {
  const client = new SrBoxVerificationClient({
    skillPath: "${UNSET_SR_BOX_SKILL_PATH}",
  });

  assert.match(
    client.scriptPath,
    /runtime\/skills\/standalone\/sr_box\/scripts\/sr_gateway_client\.py$/,
  );
});

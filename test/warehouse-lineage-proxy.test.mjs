import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWarehouseLineageToolAuthorized,
  normalizeWarehouseLineageRequest,
  proxyWarehouseLineageRequest,
} from "../src/warehouse-lineage-proxy.mjs";

test("warehouse lineage proxy only accepts allowed read-only trace requests", () => {
  assert.deepEqual(normalizeWarehouseLineageRequest({
    operation: "trace_table",
    countryCode: "MX",
    table: "dws.dws_user_info_m",
    maxFiles: 99,
  }), {
    operation: "trace_table",
    countryCode: "mx",
    table: "dws.dws_user_info_m",
    maxFiles: 20,
  });
  assert.throws(() => normalizeWarehouseLineageRequest({ operation: "run_sql", countryCode: "mx", table: "dws.x" }), /Only trace_table/);
  assert.throws(() => normalizeWarehouseLineageRequest({ operation: "trace_table", countryCode: "us", table: "dws.x" }), /Unsupported countryCode/);
  assert.throws(() => normalizeWarehouseLineageRequest({ operation: "trace_table", countryCode: "mx", table: "dws.x; DROP" }), /Invalid table name/);
});

test("warehouse lineage proxy enforces a dedicated bearer token", () => {
  const env = { DIFY_WAREHOUSE_LINEAGE_TOOL_TOKEN: "tool-secret" };
  assert.doesNotThrow(() => assertWarehouseLineageToolAuthorized({ headers: { authorization: "Bearer tool-secret" } }, env));
  assert.throws(() => assertWarehouseLineageToolAuthorized({ headers: {} }, env), { message: /Unauthorized/ });
  assert.throws(() => assertWarehouseLineageToolAuthorized({ headers: {} }, {}), { message: /not configured/ });
});

test("warehouse lineage proxy forwards only normalized payloads to the local gateway", async () => {
  let received;
  const result = await proxyWarehouseLineageRequest({ operation: "trace_table", countryCode: "mx", table: "dws.dws_user_info_m" }, {
    env: { WAREHOUSE_LINEAGE_GATEWAY_URL: "http://gateway.test/webhook" },
    fetchFn: async (_url, options) => {
      received = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, evidence: { quality: "producer_sql" } }) };
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(received, { operation: "trace_table", countryCode: "mx", table: "dws.dws_user_info_m", maxFiles: 10 });
});

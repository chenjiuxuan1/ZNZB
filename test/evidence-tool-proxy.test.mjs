import assert from "node:assert/strict";
import test from "node:test";
import { proxyWattrelQuery, proxyDsSchedulerRequest } from "../src/evidence-tool-proxy.mjs";

function mockFetch(responseBody, status = 200) {
  return async (url, options) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(responseBody),
  });
}

test("wattrel query proxy forwards country and limit to the gateway", async () => {
  let capturedBody;
  const fetchFn = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ quality_id: 1, src_tbl: "dws.orders" }] }) };
  };
  const result = await proxyWattrelQuery({ country: "MX", limit: 30 }, { fetchFn });
  assert.equal(capturedBody.country, "mx");
  assert.equal(capturedBody.limit, 30);
  assert.equal(result.data[0].src_tbl, "dws.orders");
});

test("wattrel query proxy rejects unsupported country codes", async () => {
  await assert.rejects(() => proxyWattrelQuery({ country: "xx" }, { fetchFn: mockFetch({}) }), /Unsupported countryCode/);
});

test("wattrel query proxy clamps limit to 1-200", async () => {
  let captured;
  const fetchFn = async (url, options) => {
    captured = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => "{}" };
  };
  await proxyWattrelQuery({ country: "cn", limit: 500 }, { fetchFn });
  assert.equal(captured.limit, 200);
  await proxyWattrelQuery({ country: "cn", limit: 0 }, { fetchFn });
  assert.equal(captured.limit, 1);
});

test("ds scheduler proxy injects ds_token from env by country", async () => {
  let capturedBody;
  const fetchFn = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: [{ state: "FAILURE" }] }) };
  };
  const result = await proxyDsSchedulerRequest(
    { country: "INE", action: "check_failed_instances", search_val: "daily_orders", start_time: "2026-07-27 00:00:00", end_time: "2026-07-29 23:59:59" },
    { env: { DS_API_TOKEN_INE: "test-token-ine" }, fetchFn }
  );
  assert.equal(capturedBody.country, "ine");
  assert.equal(capturedBody.action, "check_failed_instances");
  assert.equal(capturedBody.ds_token, "test-token-ine");
  assert.equal(capturedBody.payload.search_val, "daily_orders");
  assert.equal(result.success, true);
});

test("ds scheduler proxy rejects write actions", async () => {
  await assert.rejects(
    () => proxyDsSchedulerRequest({ country: "cn", action: "retry_instance" }, { env: { DS_API_TOKEN_CN: "t" }, fetchFn: mockFetch({}) }),
    /not allowed/
  );
  await assert.rejects(
    () => proxyDsSchedulerRequest({ country: "cn", action: "trigger_workflow" }, { env: { DS_API_TOKEN_CN: "t" }, fetchFn: mockFetch({}) }),
    /not allowed/
  );
});

test("ds scheduler proxy rejects when ds token not configured", async () => {
  await assert.rejects(
    () => proxyDsSchedulerRequest({ country: "ph", action: "check_failed_instances" }, { env: {}, fetchFn: mockFetch({}) }),
    /DS API token not configured/
  );
});

test("ds scheduler proxy normalizes country aliases", async () => {
  let captured;
  const fetchFn = async (url, options) => {
    captured = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => "{}" };
  };
  await proxyDsSchedulerRequest({ country: "ID", action: "list_workflows" }, { env: { DS_API_TOKEN_INE: "t" }, fetchFn });
  assert.equal(captured.country, "ine");
});

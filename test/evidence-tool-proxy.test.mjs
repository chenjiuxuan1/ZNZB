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

/* ── proxySrQuery tests ── */

import { proxySrQuery } from "../src/evidence-tool-proxy.mjs";

test("SR query proxy maps ine to id and forwards read-only SQL to the gateway", async () => {
  let capturedUrl, capturedBody, capturedHeaders;
  const fetchFn = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    capturedHeaders = options.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { columns: ["stat_date", "grant_cnt_1d"], rows: [{ stat_date: "2026-07-31", grant_cnt_1d: 0 }], total: 1 } }) };
  };
  const result = await proxySrQuery(
    { country: "ine", sql: "SELECT grant_cnt_1d FROM ads.ads_3003_user_smmary_d WHERE stat_date='2026-07-31'" },
    { env: { FUXI_SR_TOKEN: "test-token" }, fetchFn },
  );
  assert.match(capturedUrl, /\/api\/rust\/v1\/sr-sandboxes\/sql-executions$/);
  assert.equal(capturedBody.country, "id");
  assert.equal(capturedBody.sqlMode, "query");
  assert.equal(capturedHeaders.Authorization, "Bearer test-token");
  assert.deepEqual(result.columns, ["stat_date", "grant_cnt_1d"]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rowCount, 1);
});

test("SR query proxy rejects write SQL", async () => {
  const fetchFn = async () => { throw new Error("should not be called"); };
  await assert.rejects(
    () => proxySrQuery({ country: "cn", sql: "INSERT INTO testdb.t VALUES (1)" }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn }),
    /Only read-only SQL is allowed|Write\/DDL\/DML/,
  );
});

test("SR query proxy rejects DROP and DELETE", async () => {
  const fetchFn = async () => { throw new Error("should not be called"); };
  await assert.rejects(() => proxySrQuery({ country: "cn", sql: "DROP TABLE ads.t" }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn }), /Only read-only SQL is allowed/);
  await assert.rejects(() => proxySrQuery({ country: "cn", sql: "DELETE FROM ads.t" }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn }), /Only read-only SQL is allowed/);
});

test("SR query proxy rejects unsupported country", async () => {
  await assert.rejects(
    () => proxySrQuery({ country: "xx", sql: "SELECT 1" }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn: async () => ({}) }),
    /Unsupported countryCode/,
  );
});

test("SR query proxy returns 503 when no token and no valid session", async () => {
  const err = await proxySrQuery({ country: "cn", sql: "SELECT 1" }, { env: { SR_SKILLS_SESSION_FILE: "/nonexistent/session.json" }, fetchFn: async () => ({}) }).catch((e) => e);
  assert.equal(err.statusCode, 503);
  assert.match(err.message, /SR query token not available/);
});

test("SR query proxy auto-reads SSO session token from sr-skills session file", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpFile = path.join(os.tmpdir(), `sr-session-test-${Date.now()}.json`);
  const futureDate = new Date(Date.now() + 3600_000).toISOString();
  fs.writeFileSync(tmpFile, JSON.stringify({ sessionToken: "srbs_test123", expiresAt: futureDate, lastAccessedAt: new Date().toISOString() }));
  let capturedHeaders;
  const fetchFn = async (url, options) => {
    capturedHeaders = options.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { columns: [], rows: [], total: 0 } }) };
  };
  try {
    await proxySrQuery({ country: "cn", sql: "SELECT 1" }, { env: { SR_SKILLS_SESSION_FILE: tmpFile }, fetchFn });
    assert.equal(capturedHeaders.Authorization, "Bearer srbs_test123");
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("SR query proxy rejects expired SSO session and falls back to error", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmpFile = path.join(os.tmpdir(), `sr-session-expired-${Date.now()}.json`);
  const pastDate = new Date(Date.now() - 7200_000).toISOString();
  fs.writeFileSync(tmpFile, JSON.stringify({ sessionToken: "srbs_expired", expiresAt: pastDate, lastAccessedAt: pastDate }));
  try {
    const err = await proxySrQuery({ country: "cn", sql: "SELECT 1" }, { env: { SR_SKILLS_SESSION_FILE: tmpFile }, fetchFn: async () => ({}) }).catch((e) => e);
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /SR query token not available/);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test("SR query proxy allows SHOW and DESC", async () => {
  const fetchFn = async (url, options) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { columns: [], rows: [], total: 0 } }) });
  await proxySrQuery({ country: "cn", sql: "SHOW TABLES FROM ads" }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn });
  await proxySrQuery({ country: "cn", sql: "DESC ads.ads_3003_user_smmary_d" }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn });
});

test("SR query proxy clamps limit to 1-500", async () => {
  let captured;
  const fetchFn = async (url, options) => { captured = JSON.parse(options.body); return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { columns: [], rows: [], total: 0 } }) }; };
  await proxySrQuery({ country: "cn", sql: "SELECT 1", limit: 999 }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn });
  assert.equal(captured.pageSize, 500);
  await proxySrQuery({ country: "cn", sql: "SELECT 1", limit: 0 }, { env: { FUXI_SR_TOKEN: "t" }, fetchFn });
  assert.equal(captured.pageSize, 1);
});

test("SR query proxy surfaces gateway error message on 4xx", async () => {
  const fetchFn = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: "Token 无权访问" }) });
  const err = await proxySrQuery({ country: "cn", sql: "SELECT 1" }, { env: { FUXI_SR_TOKEN: "bad" }, fetchFn }).catch((e) => e);
  assert.equal(err.statusCode, 502);
  assert.match(err.message, /Token 无权访问/);
});

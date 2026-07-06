import test from "node:test";
import assert from "node:assert/strict";
import { BiGatewayClient, createGatewayQueryCardFn, extractRows } from "../src/bi-gateway-client.mjs";

test("BiGatewayClient sends normalized dashboard query payload", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ success: true, data: { rows: [{ value: 1 }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new BiGatewayClient({
    baseUrl: "https://bi-gateway.example.com/",
    token: "test-token",
    requestTimeoutSeconds: 12,
  });
  const rows = await client.queryPublicDashcardJson({
    dashboard: {
      countryCode: "INE",
      countryName: "印尼",
      timezone: "Asia/Jakarta",
      sourcePanelTitle: "OKR",
      title: "Dashboard",
      uuid: "dashboard-uuid",
      url: "https://data.kuainiu.io/public/dashboard/dashboard-uuid",
    },
    card: {
      title: "转化漏斗",
      cardId: 531,
      dashcardId: 549,
      display: "line",
    },
    parameters: [{ id: "date", value: "past30days~" }],
  });

  assert.deepEqual(rows, [{ value: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bi-gateway.example.com/api/bi-monitor/metabase/public-dashcard-json");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");

  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.country, { code: "INE", name: "印尼", timezone: "Asia/Jakarta" });
  assert.equal(payload.dashboard.uuid, "dashboard-uuid");
  assert.equal(payload.card.cardId, 531);
  assert.deepEqual(payload.parameters, [{ id: "date", value: "past30days~" }]);
});

test("createGatewayQueryCardFn returns monitor-compatible card result", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ rows: [{ ok: true }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const queryCardFn = createGatewayQueryCardFn({ baseUrl: "https://bi-gateway.example.com" });
  const result = await queryCardFn(
    null,
    { uuid: "dashboard-uuid", url: "https://data.kuainiu.io/public/dashboard/dashboard-uuid" },
    { cardId: 1, dashcardId: 2, title: "卡片" },
    [],
  );

  assert.deepEqual(result, {
    ok: true,
    rows: [{ ok: true }],
    error: null,
  });
});

test("BiGatewayClient exposes gateway error details", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, message: "token expired", traceId: "trace-001" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const client = new BiGatewayClient({ baseUrl: "https://bi-gateway.example.com" });

  await assert.rejects(
    () =>
      client.queryPublicDashcardJson({
        dashboard: { uuid: "dashboard-uuid", url: "https://data.kuainiu.io/public/dashboard/dashboard-uuid" },
        card: { cardId: 1, dashcardId: 2, title: "卡片" },
      }),
    /token expired; traceId=trace-001/,
  );
});

test("extractRows accepts gateway and raw Metabase response shapes", () => {
  assert.deepEqual(extractRows([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(extractRows({ rows: [{ a: 2 }] }), [{ a: 2 }]);
  assert.deepEqual(extractRows({ data: { rows: [{ a: 3 }] } }), [{ a: 3 }]);
  assert.deepEqual(extractRows({ result: { data: { rows: [{ a: 4 }] } } }), [{ a: 4 }]);
  assert.throws(() => extractRows({ data: { items: [] } }), /does not contain rows array/);
});

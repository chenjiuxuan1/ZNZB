import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseInternalMetabaseUrl } from "../src/metabase-internal-client.mjs";
import { parsePublicDashboardUrl } from "../src/metabase-public-client.mjs";
import {
  discoverPublicDashboards,
  extractInternalMetabaseRefs,
  extractPublicDashboardRefs,
} from "../src/metabase-discovery.mjs";

test("parsePublicDashboardUrl extracts base url and uuid", () => {
  assert.deepEqual(
    parsePublicDashboardUrl("https://data.kuainiu.io/public/dashboard/abc-123"),
    {
      baseUrl: "https://data.kuainiu.io",
      uuid: "abc-123",
      url: "https://data.kuainiu.io/public/dashboard/abc-123",
    },
  );
});

test("extractPublicDashboardRefs dedupes links", () => {
  const refs = extractPublicDashboardRefs({
    panels: [
      {
        id: 1,
        title: "A",
        links: [
          { url: "https://data.kuainiu.io/public/dashboard/abc-123" },
          { url: "https://data.kuainiu.io/public/dashboard/abc-123" },
        ],
      },
    ],
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].sourcePanelTitle, "A");
});

test("parseInternalMetabaseUrl extracts dashboard and collection ids", () => {
  assert.deepEqual(
    parseInternalMetabaseUrl("https://data.kuainiu.io/dashboard/462?date_filter=past1days~"),
    {
      baseUrl: "https://data.kuainiu.io",
      type: "dashboard",
      id: "462",
      url: "https://data.kuainiu.io/dashboard/462?date_filter=past1days~",
    },
  );
  assert.deepEqual(
    parseInternalMetabaseUrl("https://data.kuainiu.io/collection/799-okr"),
    {
      baseUrl: "https://data.kuainiu.io",
      type: "collection",
      id: "799",
      url: "https://data.kuainiu.io/collection/799-okr",
    },
  );
});

test("extractInternalMetabaseRefs keeps marked internal dashboard sources", () => {
  const refs = extractInternalMetabaseRefs({
    country: { code: "CN", name: "中国" },
    panels: [
      {
        id: 1,
        title: "业务概览-核心链路准实时监控",
        links: [{ url: "https://data.kuainiu.io/dashboard/462?date_filter=past1days~" }],
      },
    ],
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].type, "dashboard");
  assert.equal(refs[0].id, "462");
  assert.equal(refs[0].country.code, "CN");
});

test("discoverPublicDashboards expands internal collection dashboards with auth client", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "metabase-discovery-"));
  const inputFile = path.join(rootDir, "panels.json");
  await fs.writeFile(inputFile, JSON.stringify({
    country: { code: "CN", name: "中国", timezone: "Asia/Shanghai" },
    title: "核心报表监控仪表盘",
    panels: [
      {
        id: 1,
        title: "业务概览-OKR",
        links: [{ url: "https://data.kuainiu.io/collection/799-okr" }],
      },
    ],
  }));

  const fakeClient = {
    async getCollectionItems(id) {
      assert.equal(id, "799");
      return { data: [{ model: "dashboard", id: 462, name: "业务概览-核心链路准实时监控" }] };
    },
    async getDashboard(id) {
      assert.equal(id, "462");
      return {
        name: "业务概览-核心链路准实时监控",
        parameters: [],
        dashcards: [
          {
            id: 11,
            card_id: 22,
            card: {
              name: "注册数",
              display: "line",
              visualization_settings: { "graph.dimensions": ["统计日期"], "graph.metrics": ["注册数"] },
            },
            parameter_mappings: [],
          },
        ],
      };
    },
    async queryDashcardJson(request) {
      assert.equal(request.dashboardId, "462");
      assert.equal(request.dashcardId, 11);
      assert.equal(request.cardId, 22);
      return [{ "统计日期": "2026-07-07", "注册数": 10 }];
    },
  };

  const result = await discoverPublicDashboards({
    inputFile,
    internalClientFactory: () => fakeClient,
  });

  assert.equal(result.dashboardCount, 1);
  assert.equal(result.totalCardCount, 1);
  assert.equal(result.dashboards[0].access, "internal");
  assert.equal(result.dashboards[0].countryCode, "CN");
  assert.equal(result.dashboards[0].cards[0].queryStatus, "ok");
});

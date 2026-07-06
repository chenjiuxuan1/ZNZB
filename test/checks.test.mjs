import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAnomalies } from "../src/checks.mjs";

test("evaluateAnomalies flags out of range latest value", () => {
  const panels = [{ id: 1, title: "失败订单数", type: "stat" }];
  const snapshots = new Map([
    [
      1,
      {
        panelId: 1,
        panelTitle: "失败订单数",
        rowCount: 1,
        hasData: true,
        latestTimestamp: Date.now(),
        numericSeries: [
          {
            refId: "A",
            fieldName: "failed_orders",
            latestValue: 3,
            previousValue: 1,
            latestTimestamp: Date.now(),
          },
        ],
        textValues: [],
        queryErrors: [],
      },
    ],
  ]);

  const result = evaluateAnomalies({
    config: {
      grafana: {
        baseUrl: "https://example.com",
        dashboardUid: "abc123",
      },
      rules: [
        {
          panelTitle: "失败订单数",
          type: "latestValueOutsideRange",
          max: 0,
        },
      ],
      builtInChecks: {
        queryError: true,
        noData: true,
      },
    },
    dashboard: { title: "日报巡检", uid: "abc123" },
    panels,
    snapshots,
    nowMs: Date.now(),
  });

  assert.equal(result.anomalies.length, 1);
  assert.match(result.anomalies[0].message, /大于上限/);
});

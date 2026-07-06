import test from "node:test";
import assert from "node:assert/strict";
import { buildPanelSnapshot, selectSeries } from "../src/frame-data.mjs";

test("buildPanelSnapshot extracts latest numeric values", () => {
  const snapshot = buildPanelSnapshot(
    { id: 12, title: "成功率", type: "timeseries" },
    {
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: "time", type: "time" },
                  { name: "success_rate", type: "number" }
                ]
              },
              data: {
                values: [
                  [1710000000000, 1710003600000],
                  [0.98, 0.995]
                ]
              }
            }
          ]
        }
      }
    },
  );

  assert.equal(snapshot.hasData, true);
  assert.equal(snapshot.numericSeries.length, 1);
  assert.equal(snapshot.numericSeries[0].latestValue, 0.995);
  assert.equal(selectSeries(snapshot).fieldName, "success_rate");
});


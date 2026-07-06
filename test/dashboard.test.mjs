import test from "node:test";
import assert from "node:assert/strict";
import { describePanels } from "../src/dashboard.mjs";

test("describePanels extracts text panel links", () => {
  const [panel] = describePanels([
    {
      id: 8,
      title: "核心指标概览",
      type: "text",
      options: {
        content: "[日报](https://example.com/d/report) <a href=\"https://example.com/d/other\">其他报表</a>",
      },
      targets: [],
    },
  ]);

  assert.equal(panel.targetCount, 0);
  assert.match(panel.textPreview, /日报/);
  assert.deepEqual(panel.links, [
    { title: "日报", url: "https://example.com/d/report" },
    { title: "其他报表", url: "https://example.com/d/other" },
  ]);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dslPath = path.join(rootDir, "Metabase-数据侧根因分析-Agent-react.yml");

test("Dify Agent DSL uses single-stage dashboard analysis with one verdict per metric", async () => {
  const dsl = await fs.readFile(dslPath, "utf8");

  assert.match(dsl, /cases_json/);
  assert.match(dsl, /dashboard_analysis/);
  assert.match(dsl, /不再分初筛和深挖两轮/);
  assert.match(dsl, /dataSideVerdict/);
  assert.match(dsl, /每个 anomalyIndex 各一项，不多不少/);
  assert.match(dsl, /总工具调用不得超过 8 次/);
  assert.match(dsl, /总工具调用预算：最多 8 次/);
  assert.match(dsl, /不得对每个 upstreamTable 全量递归/);
  assert.match(dsl, /关键证据已经足够时，必须立即输出 finish/);
  assert.doesNotMatch(dsl, /dashboard_screening/);
  assert.doesNotMatch(dsl, /metric_deep_analysis/);
  assert.doesNotMatch(dsl, /screeningVerdict/);
  assert.doesNotMatch(dsl, /screening_json/);
});

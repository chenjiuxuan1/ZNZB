import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dslPath = path.join(rootDir, "Metabase-数据侧根因分析-Agent-react.yml");

test("Dify Agent DSL bounds investigation and permits evidence-based early finish", async () => {
  const dsl = await fs.readFile(dslPath, "utf8");

  assert.match(dsl, /max_iterations:\s*\n\s+type: constant\s*\n\s+value: 14/);
  assert.match(dsl, /总工具调用预算：最多 8 次/);
  assert.match(dsl, /不得对每个 upstreamTable 全量递归/);
  assert.match(dsl, /关键证据已经足够时，必须立即输出 finish/);
  assert.doesNotMatch(dsl, /不得在未完成第2-7步调查的情况下输出 finish/);
});

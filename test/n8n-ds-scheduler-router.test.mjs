import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const workflowFile = new URL("../n8n-ds-scheduler-router.json", import.meta.url);

async function workflow() {
  return JSON.parse(await fs.readFile(workflowFile, "utf8"));
}

test("ds scheduler router preserves the auto-repair log path", async () => {
  const data = await workflow();
  const normalize = data.nodes.find((node) => node.name === "解析并标准化请求");

  assert.ok(normalize);
  assert.match(normalize.parameters.jsCode, /'get_auto_repair_log'/);
  assert.match(normalize.parameters.jsCode, /log_path:\s*inputPayload\.log_path/);
});

test("all country SSH routes implement auto-repair log reads", async () => {
  const data = await workflow();
  const countryNodes = ["中国", "印尼", "菲律宾", "泰国", "巴基斯坦", "墨西哥"]
    .map((name) => data.nodes.find((node) => node.name === name));

  assert.ok(countryNodes.every(Boolean));
  for (const node of countryNodes) {
    assert.match(node.parameters.command, /ACTION\" = \"get_auto_repair_log/);
    assert.match(node.parameters.command, /LOG_NOT_FOUND/);
  }
});

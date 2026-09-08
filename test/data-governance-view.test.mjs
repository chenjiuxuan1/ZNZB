import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const viewUrl = new URL("../web/src/views/data-governance.js", import.meta.url);
const cssUrl = new URL("../web/src/styles.css", import.meta.url);

test("data governance renders result metadata and responsive tables", async () => {
  const source = await fs.readFile(viewUrl, "utf8");
  const css = await fs.readFile(cssUrl, "utf8");
  assert.match(source, /id="gov-result-meta">\$\{escapeHtml\(data\.resultMeta/);
  assert.match(source, /class="gov-table-wrap"/);
  assert.match(css, /\.gov-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
});

test("alert history CSS selectors are syntactically valid", async () => {
  const css = await fs.readFile(cssUrl, "utf8");
  assert.doesNotMatch(css, /^"\.mc-/m);
});

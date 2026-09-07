import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const viewUrl = new URL("../web/src/views/alert-registry.js", import.meta.url);
const cssUrl = new URL("../web/src/styles.css", import.meta.url);

test("alert registry uses a scoped operations console shell", async () => {
  const source = await fs.readFile(viewUrl, "utf8");
  assert.match(source, /class="page-header ar-console-header"/);
  assert.match(source, /class="panel ar-console-section/);
  assert.match(source, /class="ar-console-section-head"/);
});

test("message template keeps enablement and save action together", async () => {
  const source = await fs.readFile(viewUrl, "utf8");
  assert.match(source, /class="mc-message-toolbar"/);
  assert.match(source, /for="ar-msg-enabled"/);
  assert.match(source, /class="mc-message-actions"/);
  assert.match(source, /aria-live="polite"/);
});

test("styles include desktop grid and narrow fallback", async () => {
  const css = await fs.readFile(cssUrl, "utf8");
  assert.match(css, /--ar-control-height:/);
  assert.match(css, /\.mc-form-row\s*\{/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.layout:has\(\.ar-console-header\) \.sidebar/);
  assert.match(css, /\.layout:has\(\.ar-console-header\) \.nav/);
});

test("history markup escapes identifiers and fallback timestamps", async () => {
  const source = await fs.readFile(viewUrl, "utf8");
  assert.match(source, /escapeHtml\(String\(c\.code \|\| ""\)\)/);
  assert.match(source, /escapeHtml\(run\.id \? String\(run\.id\)\.slice\(0, 8\) : String\(start \+ idx \+ 1\)\)/);
  assert.match(source, /escapeHtml\(ts\)/);
});

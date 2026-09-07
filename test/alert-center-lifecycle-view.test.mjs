import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ALERT_LIFECYCLE_SECTIONS,
  normalizeAlertLifecycleSection,
  lifecycleSectionForPath,
  legacyCapabilitiesForSection,
} from "../web/src/views/alert-center/lifecycle-model.js";
import { findRouteForPath } from "../web/src/state.js";
import {
  renderLifecycleBridge,
  renderLifecycleNavigation,
} from "../web/src/views/alert-center/lifecycle-nav.js";
import { renderLegacyMigrationBanner } from "../web/src/views/alert-center/legacy-migration-banner.js";
import {
  canPublishEntry,
  filterScriptCapableEntries,
  renderHealthSources,
  renderOperationsShell,
} from "../web/src/views/alert-center/operations.js";

test("alert center exposes five lifecycle sections", () => {
  assert.deepEqual(ALERT_LIFECYCLE_SECTIONS.map((item) => item.id), [
    "overview", "events", "rules", "notifications", "operations",
  ]);
});

test("alert lifecycle routes default safely", () => {
  assert.equal(lifecycleSectionForPath("/alerts"), "overview");
  assert.equal(lifecycleSectionForPath("/alerts/events"), "events");
  assert.equal(lifecycleSectionForPath("/alerts/unknown"), "overview");
  assert.equal(normalizeAlertLifecycleSection("notifications"), "notifications");
});

test("legacy capabilities have one primary lifecycle owner", () => {
  const owners = ALERT_LIFECYCLE_SECTIONS.flatMap((section) =>
    legacyCapabilitiesForSection(section.id).map((item) => [item.id, section.id]),
  );
  assert.equal(new Set(owners.map(([id]) => id)).size, owners.length);
});

test("n8n lifecycle capability focuses the n8n rules workspace", () => {
  const item = legacyCapabilitiesForSection("rules")
    .find((candidate) => candidate.id === "n8n-alert-flows");
  assert.equal(item.href, "/alerts/rules?focus=n8n-workflows");
  assert.doesNotMatch(renderLifecycleBridge("rules"), /href="#\/rules"[^>]*>n8n 告警链路/);
});

test("rules workspace exposes a focusable n8n workflow section", () => {
  const source = fs.readFileSync(new URL("../web/src/views/alert-center.js", import.meta.url), "utf8");
  assert.match(source, /id="ac-n8n-workflows"/);
  assert.match(source, /focusLifecycleTarget\(body, readLifecycleFocus\(\)\)/);
});

test("operations workspace owns health test release and audit regions", () => {
  const html = renderOperationsShell();
  for (const title of ["连接状态", "测试与验证", "脚本与发布", "运维记录"]) {
    assert.match(html, new RegExp(title));
  }
  const source = fs.readFileSync(new URL("../web/src/views/alert-center/operations.js", import.meta.url), "utf8");
  for (const endpoint of [
    "/api/alerts/health",
    "/api/alert-registry",
    "/api/alert-registry/history",
    "/api/alert-registry/script-audit",
  ]) {
    assert.ok(source.includes(endpoint));
  }
  assert.doesNotMatch(source, /apiPut\(/);
  assert.match(source, /confirm\(/);
});

test("operations health states and publish guard remain source-specific", () => {
  const health = renderHealthSources({ nightingale: "ok", n8n: "error: timeout" });
  assert.match(health, /Nightingale[^]*连接正常/);
  assert.match(health, /n8n[^]*timeout/);

  const entries = filterScriptCapableEntries([
    { id: "script", templateName: "alert.py.tpl" },
    { id: "plain", command: "echo ok" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.id), ["script"]);
  assert.equal(canPublishEntry("script", ""), false);
  assert.equal(canPublishEntry("script", "script"), true);
});

test("alert child routes resolve to the alert sidebar entry", () => {
  const routes = [{ path: "/dashboard" }, { path: "/alerts", matchPrefix: true }];
  assert.equal(findRouteForPath(routes, "/alerts/events").path, "/alerts");
  assert.equal(findRouteForPath(routes, "/alerts/notifications").path, "/alerts");
  assert.equal(findRouteForPath(routes, "/missing").path, "/dashboard");
});

test("lifecycle workspace preserves existing alert loaders", () => {
  const navigation = renderLifecycleNavigation("events");
  const bridge = renderLifecycleBridge("operations");
  const viewSource = fs.readFileSync(new URL("../web/src/views/alert-center.js", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

  assert.match(navigation, /alert-lifecycle-nav/);
  assert.equal((navigation.match(/href="#\/alerts\//g) || []).length, 5);
  assert.match(navigation, /aria-current="page"/);
  assert.match(bridge, /运维/);
  assert.match(viewSource, /renderLifecycleNavigation/);
  assert.match(viewSource, /renderLifecycleBridge/);
  for (const loader of ["loadDashboard", "loadHistoryTab", "loadConfigTab", "loadInventoryTab"]) {
    assert.match(viewSource, new RegExp(`function ${loader}\\(`));
  }
  assert.match(styles, /\.alert-lifecycle-nav/);
});

test("legacy alert pages point to their lifecycle destination", () => {
  const destinations = {
    "alert-registry": "rules",
    rules: "rules",
    sandbox: "operations",
    "notify-preview": "notifications",
    "ds-scheduler": "rules",
    "ds-failure-logs": "events",
  };

  for (const [view, section] of Object.entries(destinations)) {
    const source = fs.readFileSync(new URL(`../web/src/views/${view}.js`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`renderLegacyMigrationBanner\\(\\"${section}\\"\\)`));
    assert.match(renderLegacyMigrationBanner(section), new RegExp(`href="#/alerts/${section}"`));
  }
  assert.equal(renderLegacyMigrationBanner("unknown"), "");
});

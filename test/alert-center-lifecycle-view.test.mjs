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

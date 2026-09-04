import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_LIFECYCLE_SECTIONS,
  normalizeAlertLifecycleSection,
  lifecycleSectionForPath,
  legacyCapabilitiesForSection,
} from "../web/src/views/alert-center/lifecycle-model.js";

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

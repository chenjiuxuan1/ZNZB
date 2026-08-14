import test from "node:test";
import assert from "node:assert/strict";
import { classifyWorkflowFailures, extractDsFailureReason, normalizeCountrySelection, normalizeGatewayFailures } from "../src/ds-failure-log-monitor.mjs";

test("DS failure log accepts a unique subset of supported countries", () => {
  assert.deepEqual(normalizeCountrySelection("th,cn,th,unknown"), ["cn", "th"]);
  assert.deepEqual(normalizeCountrySelection(["mx", "ine"]), ["ine", "mx"]);
  assert.deepEqual(normalizeCountrySelection(undefined), ["cn", "ine", "ph", "th", "pk", "mx"]);
});

test("DS failure log uses the gateway scheduled-today recovery verdict", () => {
  const failures = normalizeGatewayFailures({
    failed_workflows: [
      { workflow_code: "a", workflow_name: "recovered", schedule_status: "ONLINE", failure_reason: "scheduled_instance_failed", has_later_success: true, instance_id: "a1", instance_state: "FAILURE", start_time: "2026-08-14T01:00:00Z" },
      { workflow_code: "b", workflow_name: "unresolved", schedule_status: "ONLINE", failure_reason: "scheduled_instance_failed", has_later_success: false, instance_id: "b1", instance_state: "FAILURE", start_time: "2026-08-14T02:00:00Z" },
      { workflow_code: "c", workflow_name: "offline", schedule_status: "OFFLINE", failure_reason: "scheduled_instance_failed", instance_id: "c1", instance_state: "FAILURE" },
    ],
  }, { projectName: "DW_DM", projectCode: "1001", targetDate: "2026-08-14", timeZone: "UTC" });
  assert.equal(failures.length, 2);
  assert.equal(failures.find((item) => item.workflowCode === "a").repairStatus, "recovered");
  assert.equal(failures.find((item) => item.workflowCode === "b").repairStatus, "unresolved");
});

test("DS failure log classifies recovered repairing and unresolved workflows", () => {
  const failures = classifyWorkflowFailures([
    { workflow_code: "a", workflow_name: "已恢复任务", instance_id: "a1", state: "FAILURE", start_time: "2026-08-14T01:00:00Z" },
    { workflow_code: "a", workflow_name: "已恢复任务", instance_id: "a2", state: "SUCCESS", start_time: "2026-08-14T02:00:00Z" },
    { workflow_code: "b", workflow_name: "修复中任务", instance_id: "b1", state: "FAILURE", start_time: "2026-08-14T03:00:00Z" },
    { workflow_code: "b", workflow_name: "修复中任务", instance_id: "b2", state: "RUNNING_EXECUTION", start_time: "2026-08-14T04:00:00Z" },
    { workflow_code: "c", workflow_name: "待修复任务", instance_id: "c1", state: "FAILURE", start_time: "2026-08-14T05:00:00Z" },
  ], { projectName: "DW_DM", projectCode: "1001" });

  assert.equal(failures.find((item) => item.workflowCode === "a").repairStatus, "recovered");
  assert.equal(failures.find((item) => item.workflowCode === "a").recoveryInstanceId, "a2");
  assert.equal(failures.find((item) => item.workflowCode === "b").repairStatus, "repairing");
  assert.equal(failures.find((item) => item.workflowCode === "c").repairStatus, "unresolved");
});

test("DS failure log uses the newest failure when a workflow fails again after recovery", () => {
  const [failure] = classifyWorkflowFailures([
    { workflow_code: "a", instance_id: "a1", state: "FAILURE", start_time: "2026-08-14T01:00:00Z" },
    { workflow_code: "a", instance_id: "a2", state: "SUCCESS", start_time: "2026-08-14T02:00:00Z" },
    { workflow_code: "a", instance_id: "a3", state: "FAILURE", start_time: "2026-08-14T03:00:00Z" },
  ]);
  assert.equal(failure.instanceId, "a3");
  assert.equal(failure.repairStatus, "unresolved");
  assert.equal(failure.failureCount, 2);
});

test("DS failure reason extracts the concrete final error line", () => {
  const reason = extractDsFailureReason([
    "INFO task started",
    "ERROR run etl fail",
    "Caused by: StarRocks query failed: Table 'dw.dwd_orders' does not exist",
  ].join("\n"));
  assert.equal(reason, "StarRocks query failed: Table 'dw.dwd_orders' does not exist");
});

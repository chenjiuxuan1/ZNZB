import test from "node:test";
import assert from "node:assert/strict";
import { classifyDsFailureType } from "../src/ds-failure-log-monitor.mjs";
import { createDsAutoRetryManager } from "../src/ds-auto-retry-manager.mjs";

const fixedNow = new Date("2026-08-18T10:00:00+08:00");

function resultWith(failure) {
  return {
    totalFailures: 1,
    countries: [{ country: "cn", failures: [{
      projectCode: "1001", workflowCode: "2001", instanceId: "3001",
      instanceState: "FAILURE", startTime: "2026-08-18 09:00:00",
      repairStatus: "unresolved", ...failure,
    }] }],
  };
}

async function enableAndWait(manager) {
  manager.enable({ startAt: fixedNow.toISOString() });
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([...manager.active.values()]);
}

test("retries every failure except SQL/code and permission errors", () => {
  assert.equal(classifyDsFailureType({ failureMessage: "SQL syntax error near FROM" }).failureType, "sql_code_error");
  assert.equal(classifyDsFailureType({ taskName: "etl", failureMessage: "Container killed: out of memory" }).failureType, "retryable");
  assert.equal(classifyDsFailureType({ taskName: "etl", failureMessage: "Connection reset by peer" }).retryable, true);
  assert.deepEqual(classifyDsFailureType({ failureMessage: "Permission denied for table ads.orders" }), {
    failureType: "permission_error",
    retryable: false,
    retryDecision: "权限不足，需人工处理",
  });
  assert.equal(classifyDsFailureType({ failureMessage: "用户没有权限访问该表" }).failureType, "permission_error");
  assert.equal(classifyDsFailureType({ taskName: "etl", failureMessage: "business validation failed" }).retryable, true);
  assert.equal(classifyDsFailureType({ failureMessage: "business validation failed" }).failureType, "suspected_empty_run");
});

test("does not start retry loop for SQL code errors", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Unknown column bad_id" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.equal(manager.active.size, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "sql_code_error");
});

test("does not start retry loop for permission errors", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Access denied for table dw.orders" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.equal(manager.active.size, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "permission_error");
});

test("keeps retryable failures running until the instance succeeds", async () => {
  const actions = [];
  let instanceChecks = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Memory limit exceeded" }) }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => {
      actions.push(action);
      if (action === "get_instance") return { state: ++instanceChecks === 1 ? "FAILURE" : "SUCCESS" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      return { success: true };
    },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance", "get_workflow", "retry_instance", "get_instance"]);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "recovered");
  assert.equal([...manager.statuses.values()][0].attempts, 1);
});

test("stops a suspected empty run after one hour", async () => {
  const actions = [];
  let current = new Date(fixedNow);
  const failure = classifyDsFailureType({ failureMessage: "workflow failed without a task node" });
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith(failure),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => {
      actions.push(action);
      if (action === "get_instance") return { state: "FAILURE" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      return { success: true };
    },
    now: () => current,
    sleep: async () => { current = new Date(current.getTime() + 60 * 60 * 1000); },
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance", "get_workflow", "retry_instance"]);
  const status = [...manager.statuses.values()][0];
  assert.equal(status.autoRetryStatus, "safety_stopped");
  assert.match(status.stopReason, /1 小时/);
  assert.ok(manager.getLogs().some((item) => item.event === "empty_run_timeout"));
});

test("stops without retry when the workflow is offline", async () => {
  const actions = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "CPU limit exceeded" }) }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => {
      actions.push(action);
      if (action === "get_instance") return { state: "FAILURE" };
      if (action === "get_workflow") return { releaseState: "OFFLINE" };
      return {};
    },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance", "get_workflow"]);
  assert.match([...manager.statuses.values()][0].stopReason, /工作流已下线/);
});

test("does not retry an instance that was manually stopped", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ instanceState: "STOP", ...classifyDsFailureType({ instanceState: "STOP" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "safety_stopped");
});

test("terminates a retryable instance when its failure date is no longer today", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ startTime: "2026-08-17 23:00:00", ...classifyDsFailureType({ failureMessage: "Connection reset by peer" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.match([...manager.statuses.values()][0].stopReason, /跨天/);
});

test("is disabled by default and waits until the selected start time", async () => {
  let inspected = 0;
  let current = new Date(fixedNow);
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => { inspected += 1; return { totalFailures: 0, countries: [] }; },
    now: () => current,
  });
  assert.deepEqual(await manager.scan(), { skipped: true, reason: "disabled" });
  manager.enable({ startAt: "2026-08-18T11:00:00+08:00" });
  assert.equal((await manager.scan()).reason, "scheduled");
  assert.equal(inspected, 0);
  current = new Date("2026-08-18T11:00:00+08:00");
  await manager.scan();
  assert.equal(inspected, 1);
  manager.disable();
  assert.equal(manager.control().enabled, false);
  assert.ok(manager.getLogs().some((item) => item.event === "control_disabled"));
});

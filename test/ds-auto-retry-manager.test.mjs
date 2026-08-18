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

test("classifies SQL errors separately from retryable resource failures", () => {
  assert.equal(classifyDsFailureType({ failureMessage: "SQL syntax error near FROM" }).failureType, "sql_code_error");
  assert.equal(classifyDsFailureType({ failureMessage: "Container killed: out of memory" }).failureType, "retryable");
  assert.equal(classifyDsFailureType({ failureMessage: "Connection reset by peer" }).retryable, true);
  assert.equal(classifyDsFailureType({ failureMessage: "business validation failed" }).failureType, "manual_review");
});

test("does not start retry loop for SQL code errors", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Unknown column bad_id" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await manager.scan();
  assert.equal(actions, 0);
  assert.equal(manager.active.size, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "sql_code_error");
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
  await manager.scan();
  await Promise.all([...manager.active.values()]);
  assert.deepEqual(actions, ["get_instance", "get_workflow", "retry_instance", "get_instance"]);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "recovered");
  assert.equal([...manager.statuses.values()][0].attempts, 1);
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
  await manager.scan();
  await Promise.all([...manager.active.values()]);
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
  await manager.scan();
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
  await manager.scan();
  await Promise.all([...manager.active.values()]);
  assert.equal(actions, 0);
  assert.match([...manager.statuses.values()][0].stopReason, /跨天/);
});

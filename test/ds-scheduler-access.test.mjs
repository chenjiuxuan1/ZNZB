import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildGatewayPolicy,
  classifyAction,
  collectUsers,
  detectViolations,
  evaluateAccess,
  loadAccessPolicy,
  normalizeAccessPolicy,
  normalizeUserEntry,
  roleClasses,
  saveAccessPolicy,
  DEFAULT_LIMITS,
} from "../src/ds-scheduler-access.mjs";

const BASE_POLICY = {
  enforcement: true,
  defaultRole: "operator",
  enforceUnknown: true,
  globalLimits: { maxCreatesPerHour: 2 },
  users: {
    admin: { username: "admin", tokens: ["TOK-A"], role: "admin", enabled: true, deleteAllowed: true },
    zhang: { username: "zhang", tokens: ["TOK-Z"], role: "operator", enabled: true, deleteAllowed: false, deniedActions: ["delete_task"], note: "值班同事" },
    blocked: { username: "blocked", role: "operator", enabled: false },
  },
};

const ROWS = [
  { operation_time: "2026-08-21 10:00:00", action: "create_workflow", token: "TOK-Z", success: 1 },
  { operation_time: "2026-08-21 10:30:00", action: "create_workflow", token: "TOK-Z", success: 1 },
  { operation_time: "2026-08-21 11:00:00", action: "list_projects", token: "TOK-Z", success: 1 },
  { operation_time: "2026-08-21 10:00:00", action: "delete_task", token: "TOK-A", success: 1 },
];
const NOW = new Date("2026-08-21T11:00:00");

test("classifyAction maps actions to classes", () => {
  assert.equal(classifyAction("list_projects"), "read");
  assert.equal(classifyAction("create_workflow"), "write");
  assert.equal(classifyAction("trigger_workflow"), "control");
  assert.equal(classifyAction("delete_task"), "delete");
  assert.equal(classifyAction("disable_task"), "delete");
  assert.equal(classifyAction("unknown"), "unknown");
  assert.ok(roleClasses("admin").has("delete"));
  assert.ok(!roleClasses("readonly").has("write"));
});

test("normalizeAccessPolicy keeps defaults and explicit overrides", () => {
  const p = normalizeAccessPolicy(BASE_POLICY);
  assert.equal(p.enforcement, true);
  assert.equal(p.defaultRole, "operator");
  assert.equal(p.globalLimits.maxCreatesPerHour, 2);
  assert.equal(p.globalLimits.maxActionsPerHour, DEFAULT_LIMITS.maxActionsPerHour);
  assert.equal(p.users.zhang.limits, null, "no per-user limit override");
  assert.equal(p.users.admin.role, "admin");
  const entry = normalizeUserEntry({ username: "x", role: "bad", limits: { maxCreatesPerDay: 5 } });
  assert.equal(entry.role, "operator");
  assert.deepEqual(entry.limits, { maxCreatesPerDay: 5 });
});

test("evaluateAccess: admin delete allowed, operator delete denied", () => {
  const admin = evaluateAccess({ username: "admin", action: "delete_task", policy: BASE_POLICY });
  assert.equal(admin.allowed, true);
  const zhang = evaluateAccess({ username: "zhang", action: "delete_task", policy: BASE_POLICY });
  assert.equal(zhang.allowed, false);
  assert.equal(zhang.code, "ACCESS_ACTION_DENIED");
});

test("evaluateAccess: disabled user denied", () => {
  const d = evaluateAccess({ username: "blocked", action: "list_projects", policy: BASE_POLICY });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "ACCESS_USER_DISABLED");
});

test("evaluateAccess: limit preview blocks when quota reached in current hour", () => {
  const d = evaluateAccess({ username: "zhang", action: "create_workflow", policy: BASE_POLICY, rows: ROWS, now: new Date("2026-08-21T10:30:00") });
  assert.equal(d.allowed, false, JSON.stringify(d));
  assert.equal(d.code, "ACCESS_LIMIT_EXCEEDED");
  assert.equal(d.detail.limitKey, "maxCreatesPerHour");
  // read still allowed
  const read = evaluateAccess({ username: "zhang", action: "list_projects", policy: BASE_POLICY, rows: ROWS, now: new Date("2026-08-21T10:30:00") });
  assert.equal(read.allowed, true);
});

test("evaluateAccess resolves username from configured token binding", () => {
  const d = evaluateAccess({ token: "TOK-Z", action: "create_workflow", policy: BASE_POLICY });
  assert.equal(d.allowed, true, JSON.stringify(d));
});

test("evaluateAccess allows non-create write within quota", () => {
  const d = evaluateAccess({ username: "zhang", action: "update_schedule", policy: BASE_POLICY, rows: ROWS, now: NOW });
  assert.equal(d.allowed, true, JSON.stringify(d));
});

test("detectViolations flags exceeded create quota per hour", () => {
  const violations = detectViolations({ rows: ROWS, tokenUserMap: { "TOK-Z": "zhang", "TOK-A": "admin" }, policy: BASE_POLICY, days: 7, now: NOW });
  const hit = violations.find((v) => v.username === "zhang" && v.metric === "maxCreatesPerHour");
  assert.ok(hit, JSON.stringify(violations));
  assert.equal(hit.limit, 2);
  assert.equal(hit.actual, 2);
  assert.equal(hit.windowType, "hour");
});

test("buildGatewayPolicy maps users to token rules and known tokens to default role", () => {
  const gw = buildGatewayPolicy({
    policy: BASE_POLICY,
    tokenUserMap: { "TOK-Z": "zhang", "TOK-NEW": "newuser" },
  });
  assert.equal(gw.enforce, true);
  assert.equal(gw.globalLimits.maxCreatesPerHour, 2);
  assert.equal(gw.tokens["TOK-A"].role, "admin");
  assert.equal(gw.tokens["TOK-A"].deleteAllowed, true);
  assert.equal(gw.tokens["TOK-Z"].deleteAllowed, false);
  assert.deepEqual(gw.tokens["TOK-Z"].deniedActions, ["delete_task"]);
  assert.equal(gw.tokens["TOK-NEW"].role, "operator");
  // A configured user without any bound token must surface a publish warning.
  assert.equal(gw.tokens["TOK-BLOCKED"], undefined);
  assert.ok(gw.warnings.some((w) => w.username === "blocked"));
});

test("collectUsers merges configured users, tokens and usage", () => {
  const users = collectUsers({
    rows: ROWS,
    tokenUserMap: { "TOK-Z": "zhang", "TOK-A": "admin" },
    policy: BASE_POLICY,
    days: 7,
    now: NOW,
  });
  const zhang = users.find((u) => u.username === "zhang");
  assert.ok(zhang);
  assert.equal(zhang.configured, true);
  assert.equal(zhang.role, "operator");
  assert.deepEqual(zhang.tokens, ["TOK-Z"]);
  assert.equal(zhang.note, "值班同事");
  assert.equal(zhang.limits, null);
  assert.equal(zhang.requests, 3);
  assert.equal(zhang.violations.length >= 1, true);
  assert.equal(zhang.status, "limited");
  const admin = users.find((u) => u.username === "admin");
  assert.equal(admin.deleteAllowed, true);
  const blocked = users.find((u) => u.username === "blocked");
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.status, "blocked");
});

test("saveAccessPolicy/loadAccessPolicy round trip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-access-"));
  try {
    const saved = await saveAccessPolicy(dir, BASE_POLICY);
    assert.ok(saved.updatedAt);
    const loaded = await loadAccessPolicy(dir);
    assert.equal(loaded.users.zhang.role, "operator");
    assert.equal(loaded.globalLimits.maxCreatesPerHour, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

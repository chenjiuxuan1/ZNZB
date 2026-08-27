import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./utils.mjs";
import { normalizeAuditRow, tokenUser, TOKEN_USER_MAP } from "./ds-scheduler-usage.mjs";

export { loadDsTokenUserMap } from "./ds-scheduler-usage.mjs";

// ---------------------------------------------------------------------------
// DS 网关访问控制：用户权限 / 限额 / 违规检测 / 网关策略生成。
// 与网关侧 gateway/access.py 的判定逻辑保持一致。
// ---------------------------------------------------------------------------

export const ACCESS_POLICY_FILE = "config/ds-scheduler-access-policy.json";
export const GATEWAY_POLICY_FILE = "config/ds-scheduler-access-gateway.json";
export const USAGE_SNAPSHOT_FILE = "config/ds-scheduler-usage-snapshot.json";

export const ACTION_CLASSES = {
  resolve_project: "read",
  list_alert_groups: "read",
  list_projects: "read",
  list_workflows: "read",
  get_workflow: "read",
  list_schedules: "read",
  get_schedule: "read",
  schedule_blast_radius: "read",
  list_instances: "read",
  get_instance: "read",
  list_task_instances: "read",
  get_task_log: "read",
  check_failed_instances: "read",
  list_datasources: "read",
  get_datasource: "read",
  extract_task_runtime_config: "read",
  list_resources: "read",
  view_resource_file: "read",
  search_resource_sql: "read",
  find_resource_usage: "read",
  search_country_git_sql: "read",
  dump_workflow_graph: "read",

  create_workflow: "write",
  create_schedule: "write",
  update_schedule: "write",
  batch_update_schedule_alerts: "write",
  append_task: "write",
  append_sql_task: "write",
  append_shell_task: "write",
  update_task: "write",
  update_sql_task: "write",
  update_shell_task: "write",

  online_schedule: "control",
  offline_schedule: "control",
  online_workflow: "control",
  offline_workflow: "control",
  trigger_workflow: "control",
  retry_instance: "control",
  stop_instance: "control",
  force_fail_instance: "control",

  delete_task: "delete",
  disable_tasks_except: "delete",
  disable_task: "delete",
};

export const ROLE_CLASSES = {
  readonly: new Set(["read"]),
  operator: new Set(["read", "write"]),
  power: new Set(["read", "write", "control"]),
  admin: new Set(["read", "write", "control", "delete"]),
};

export const ROLE_LABELS = {
  readonly: "只读",
  operator: "运维（读写）",
  power: "高级（+上线/触发/停止）",
  admin: "管理员（含删除）",
};

const CREATE_METRIC_ACTIONS = new Set(["create_workflow", "create_schedule", "append_task", "append_sql_task", "append_shell_task"]);
const DELETE_METRIC_ACTIONS = new Set(["delete_task", "disable_task", "disable_tasks_except"]);
const TRIGGER_METRIC_ACTIONS = new Set(["trigger_workflow", "retry_instance"]);

export const DEFAULT_LIMITS = {
  maxActionsPerHour: 200,
  maxActionsPerDay: 500,
  maxCreatesPerHour: 10,
  maxCreatesPerDay: 30,
  maxDeletesPerDay: 20,
  maxTriggersPerHour: 30,
};

export const LIMIT_LABELS = {
  maxActionsPerHour: "每小时总操作数",
  maxActionsPerDay: "每日总操作数",
  maxCreatesPerHour: "每小时新建数",
  maxCreatesPerDay: "每日新建数",
  maxDeletesPerDay: "每日删除/禁用数",
  maxTriggersPerHour: "每小时触发数",
};

export function classifyAction(action) {
  return ACTION_CLASSES[String(action || "").trim()] || "unknown";
}

export function roleClasses(role) {
  return ROLE_CLASSES[String(role || "").trim()] || ROLE_CLASSES.readonly;
}

export const DEFAULT_ACCESS_POLICY = {
  version: 1,
  updatedAt: "",
  enforcement: true,
  defaultRole: "operator",
  enforceUnknown: true,
  globalLimits: { ...DEFAULT_LIMITS },
  users: {},
};

function str(value) {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return String(value).trim().toLowerCase() === "true";
}

function intArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(str).filter(Boolean))] : [];
}

function pickLimitOverrides(input = {}) {
  const out = {};
  if (input && typeof input === "object") {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      if (input[key] === undefined || input[key] === null) continue;
      const value = Number(input[key]);
      if (Number.isFinite(value) && value >= 0) out[key] = Math.round(value);
    }
  }
  return Object.keys(out).length ? out : null;
}

function normalizeLimits(input = {}, { defaults = false } = {}) {
  const overrides = pickLimitOverrides(input);
  if (defaults) return { ...DEFAULT_LIMITS, ...(overrides || {}) };
  return overrides; // null when no explicit override
}

export function normalizeUserEntry(input = {}) {
  const role = str(input.role);
  return {
    username: str(input.username),
    tokens: intArray(input.tokens),
    role: Object.prototype.hasOwnProperty.call(ROLE_CLASSES, role) ? role : "operator",
    enabled: bool(input.enabled, true),
    note: str(input.note),
    deleteAllowed: bool(input.deleteAllowed, false),
    allowedActions: Array.isArray(input.allowedActions) ? intArray(input.allowedActions) : null,
    deniedActions: intArray(input.deniedActions),
    limits: normalizeLimits(input.limits),
  };
}

export function normalizeAccessPolicy(raw = {}) {
  const users = {};
  for (const [username, entry] of Object.entries((raw && raw.users) || {})) {
    if (!username) continue;
    users[username] = normalizeUserEntry({ ...(entry && typeof entry === "object" ? entry : {}), username });
  }
  const defaultRole = str(raw && raw.defaultRole);
  return {
    version: Number((raw && raw.version) || 1),
    updatedAt: str(raw && raw.updatedAt),
    enforcement: bool(raw && raw.enforcement, true),
    defaultRole: Object.prototype.hasOwnProperty.call(ROLE_CLASSES, defaultRole) ? defaultRole : "operator",
    enforceUnknown: bool(raw && raw.enforceUnknown, true),
    globalLimits: normalizeLimits((raw && raw.globalLimits) || {}, { defaults: true }),
    users,
  };
}

export async function loadAccessPolicy(rootDir) {
  const filePath = path.resolve(rootDir, ACCESS_POLICY_FILE);
  let raw = null;
  try {
    raw = await readJsonFile(filePath, null);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return normalizeAccessPolicy(raw);
}

export async function saveAccessPolicy(rootDir, policy) {
  const filePath = path.resolve(rootDir, ACCESS_POLICY_FILE);
  const normalized = normalizeAccessPolicy(policy);
  normalized.updatedAt = new Date().toISOString();
  await writeJsonFileAtomic(filePath, normalized);
  return normalized;
}

export async function loadUsageRows(rootDir) {
  const filePath = path.resolve(rootDir, USAGE_SNAPSHOT_FILE);
  try {
    const snapshot = await readJsonFile(filePath, null);
    if (snapshot && Array.isArray(snapshot.rows)) return snapshot.rows;
    return [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}

// ---------------------------------------------------------------------------
// 用户归并：策略配置 + token 映射 + 审计记录 -> 用户列表
// ---------------------------------------------------------------------------

function hourKeyOf(operationTime) {
  const match = String(operationTime || "").match(/^(\d{4}-\d{2}-\d{2}) (\d{2})/);
  return match ? `${match[1]} ${match[2]}` : null;
}

function dayKeyOf(operationTime) {
  const match = String(operationTime || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function nowHourKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}`;
}

export function nowDayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Merge users from policy config, the token->username map and audit rows.
 * Each user carries usage stats (within `days` back from now) plus effective
 * permission fields.
 */
export function collectUsers({ rows = [], tokenUserMap = {}, policy, days = 7, now = new Date() }) {
  const p = normalizeAccessPolicy(policy);
  const merged = new Map();

  const ensure = (username) => {
    const name = str(username) || "未知";
    if (!merged.has(name)) {
      const cfg = p.users[name];
      const limitOverrides = cfg && cfg.limits && Object.keys(cfg.limits).length ? { ...cfg.limits } : null;
      merged.set(name, {
        username: name,
        configured: Boolean(cfg),
        role: cfg ? cfg.role : p.defaultRole,
        enabled: cfg ? cfg.enabled : true,
        deleteAllowed: cfg ? cfg.deleteAllowed : false,
        deniedActions: cfg ? [...cfg.deniedActions] : [],
        allowedActions: cfg && Array.isArray(cfg.allowedActions) ? [...cfg.allowedActions] : null,
        limits: limitOverrides,
        note: cfg ? (cfg.note || "") : "",
        tokens: new Set(cfg ? [...(cfg.tokens || [])] : []),
        requests: 0,
        riskActions: 0,
        creates: 0,
        deletes: 0,
        triggers: 0,
        sources: new Set(),
        countries: new Set(),
        lastUsedAt: null,
        violations: [],
      });
    }
    return merged.get(name);
  };

  // 1) configured users
  for (const [username, cfg] of Object.entries(p.users)) {
    ensure(username);
  }
  // 2) token map -> usernames (bind tokens to users)
  for (const [token, username] of Object.entries(tokenUserMap || {})) {
    const user = ensure(str(username));
    user.tokens.add(str(token));
  }
  // 3) static token map
  for (const [token, username] of Object.entries(TOKEN_USER_MAP)) {
    const user = ensure(str(username));
    user.tokens.add(str(token));
  }

  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const hourBuckets = new Map(); // username -> Map(hourKey -> {total, creates, deletes, triggers})
  const dayBuckets = new Map(); // username -> Map(dayKey -> {total, creates, deletes, triggers})

  const bump = (bucketMap, username, key, type) => {
    let map = bucketMap.get(username);
    if (!map) { map = new Map(); bucketMap.set(username, map); }
    let bucket = map.get(key);
    if (!bucket) { bucket = { total: 0, creates: 0, deletes: 0, triggers: 0 }; map.set(key, bucket); }
    bucket.total += 1;
    bucket[type] = (bucket[type] || 0) + 1;
  };

  for (const raw of rows) {
    const row = normalizeAuditRow(raw);
    const opTime = row.operationTime;
    const ts = Date.parse(opTime);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const username = tokenUser(row.token, tokenUserMap) || row.operator || "未知";
    const user = ensure(username);
    user.requests += 1;
    if (row.riskLevel === "high" || row.riskLevel === "medium") user.riskActions += 1;
    const type = CREATE_METRIC_ACTIONS.has(row.action) ? "creates" : DELETE_METRIC_ACTIONS.has(row.action) ? "deletes" : TRIGGER_METRIC_ACTIONS.has(row.action) ? "triggers" : "total";
    const hKey = hourKeyOf(opTime);
    const dKey = dayKeyOf(opTime);
    if (hKey) bump(hourBuckets, username, hKey, type);
    if (dKey) bump(dayBuckets, username, dKey, type);
    if (row.source) user.sources.add(row.source);
    if (row.country) user.countries.add(row.country);
    if (!user.lastUsedAt || opTime > user.lastUsedAt) user.lastUsedAt = opTime;
  }

  // violations from bucket aggregation
  for (const [username, map] of hourBuckets.entries()) {
    for (const [key, bucket] of map.entries()) {
      pushViolationsFor(merged, username, bucket, key, "hour", p);
    }
  }
  for (const [username, map] of dayBuckets.entries()) {
    for (const [key, bucket] of map.entries()) {
      pushViolationsFor(merged, username, bucket, key, "day", p);
    }
  }

  const users = [...merged.values()].map((u) => ({
    username: u.username,
    configured: u.configured,
    role: u.role,
    enabled: u.enabled,
    deleteAllowed: u.deleteAllowed,
    deniedActions: u.deniedActions,
    allowedActions: u.allowedActions,
    limits: u.limits,
    note: u.note,
    tokens: [...u.tokens].sort(),
    requests: u.requests,
    riskActions: u.riskActions,
    sources: [...u.sources].sort(),
    countries: [...u.countries].sort(),
    lastUsedAt: u.lastUsedAt,
    violations: u.violations,
    status: !u.enabled ? "blocked" : u.violations.length ? "limited" : "normal",
  }));
  users.sort((a, b) => (Number(b.configured) - Number(a.configured)) || (b.requests - a.requests));
  return users;
}

function pushViolationsFor(merged, username, bucket, windowKey, windowType, policy) {
  const user = merged.get(username);
  if (!user) return;
  const limits = mergeLimits(user.limits, policy.globalLimits);
  const checks = [
    ["maxActionsPerHour", bucket.total, "hour", "小时总操作数"],
    ["maxActionsPerDay", bucket.total, "day", "当日总操作数"],
    ["maxCreatesPerHour", bucket.creates, "hour", "小时新建数"],
    ["maxCreatesPerDay", bucket.creates, "day", "当日新建数"],
    ["maxDeletesPerDay", bucket.deletes, "day", "当日删除/禁用数"],
    ["maxTriggersPerHour", bucket.triggers, "hour", "小时触发数"],
  ];
  for (const [limitKey, actual, appliesWindow, label] of checks) {
    if (appliesWindow !== windowType) continue;
    const limit = limits[limitKey];
    if (limit != null && actual >= limit) {
      user.violations.push({
        username,
        metric: limitKey,
        metricLabel: label,
        limit,
        actual,
        window: windowKey,
        windowType,
        at: windowKey,
      });
    }
  }
}

function mergeLimits(userLimits, globalLimits) {
  return { ...DEFAULT_LIMITS, ...(globalLimits || {}), ...(userLimits || {}) };
}

// ---------------------------------------------------------------------------
// 权限判定（与网关一致）
// ---------------------------------------------------------------------------

export function evaluateAccess({ username = "", token = "", action = "", country = "", policy, tokenUserMap = {}, rows = [], now = new Date() }) {
  const p = normalizeAccessPolicy(policy);
  // Resolve username from token: prefer configured user's own bound tokens,
  // then the runtime token map / static map.
  const boundTokens = new Map();
  for (const [name, cfg] of Object.entries(p.users)) {
    for (const t of cfg.tokens || []) boundTokens.set(str(t), name);
  }
  const resolvedUsername = str(username)
    || (token ? (boundTokens.get(str(token)) || tokenUser(str(token), tokenUserMap)) : "");
  const cfg = p.users[resolvedUsername] || null;
  const decision = { allowed: true, code: null, message: "", detail: null };

  if (cfg && !cfg.enabled) {
    return deny("ACCESS_USER_DISABLED", `用户 ${resolvedUsername} 已被禁用`, resolvedUsername, action);
  }
  const role = cfg ? cfg.role : p.defaultRole;
  const classes = roleClasses(role);
  const denied = new Set(cfg ? cfg.deniedActions : []);
  const allowedList = cfg && Array.isArray(cfg.allowedActions) ? new Set(cfg.allowedActions) : null;
  const deleteAllowed = cfg ? cfg.deleteAllowed : false;
  const actionClass = classifyAction(action);

  if (denied.has(action)) return deny("ACCESS_ACTION_DENIED", `用户 ${resolvedUsername} 无权执行动作 ${action}`, resolvedUsername, action);
  if (allowedList && !allowedList.has(action)) return deny("ACCESS_ACTION_NOT_ALLOWED", `用户 ${resolvedUsername} 不在 ${action} 的动作白名单内`, resolvedUsername, action);
  if (!classes.has(actionClass) && !(actionClass === "delete" && deleteAllowed)) {
    const reason = actionClass === "delete" ? "用户未开放删除权限" : `用户角色不允许 ${actionClass} 类操作`;
    return deny("ACCESS_CLASS_DENIED", `用户 ${resolvedUsername} ${reason}（${action}）`, resolvedUsername, action);
  }

  // 限额预览（基于审计快照，权威拦截以网关为准）
  const resolveRowUser = (row) => boundTokens.get(str(row.token)) || tokenUser(row.token, tokenUserMap) || row.operator || "";
  const limits = mergeLimits(cfg ? cfg.limits : null, p.globalLimits);
  const currentHour = nowHourKey(now);
  const currentDay = nowDayKey(now);
  const counts = { totalH: 0, totalD: 0, createsH: 0, createsD: 0, deletesD: 0, triggersH: 0 };
  for (const raw of rows) {
    const row = normalizeAuditRow(raw);
    if (resolveRowUser(row) !== resolvedUsername) continue;
    const hKey = hourKeyOf(row.operationTime);
    const dKey = dayKeyOf(row.operationTime);
    if (hKey !== currentHour && dKey !== currentDay) continue;
    const type = CREATE_METRIC_ACTIONS.has(row.action) ? "creates" : DELETE_METRIC_ACTIONS.has(row.action) ? "deletes" : TRIGGER_METRIC_ACTIONS.has(row.action) ? "triggers" : "total";
    if (hKey === currentHour) {
      counts.totalH += 1;
      if (type === "creates") counts.createsH += 1;
      if (type === "triggers") counts.triggersH += 1;
    }
    if (dKey === currentDay) {
      counts.totalD += 1;
      if (type === "creates") counts.createsD += 1;
      if (type === "deletes") counts.deletesD += 1;
    }
  }
  const metrics = new Set();
  if (CREATE_METRIC_ACTIONS.has(action)) metrics.add("creates");
  if (DELETE_METRIC_ACTIONS.has(action)) metrics.add("deletes");
  if (TRIGGER_METRIC_ACTIONS.has(action)) metrics.add("triggers");

  const checks = [
    ["maxActionsPerHour", counts.totalH, "小时总操作数", true],
    ["maxActionsPerDay", counts.totalD, "当日总操作数", true],
    ["maxCreatesPerHour", counts.createsH, "小时新建数", metrics.has("creates")],
    ["maxCreatesPerDay", counts.createsD, "当日新建数", metrics.has("creates")],
    ["maxDeletesPerDay", counts.deletesD, "当日删除/禁用数", metrics.has("deletes")],
    ["maxTriggersPerHour", counts.triggersH, "小时触发数", metrics.has("triggers")],
  ];
  for (const [key, actual, label, applies] of checks) {
    if (!applies) continue;
    const limit = limits[key];
    if (limit != null && actual >= limit) {
      return {
        allowed: false,
        code: "ACCESS_LIMIT_EXCEEDED",
        message: `用户 ${resolvedUsername} 触发管控阈值：${label} ${actual} 已达上限 ${limit}（策略 ${key}）`,
        detail: { username: resolvedUsername, action, actionClass, limitKey: key, limit, actual, window: currentHour },
      };
    }
  }

  decision.detail = {
    username: resolvedUsername,
    token: str(token),
    country: str(country),
    action,
    actionClass,
    role,
    deleteAllowed,
    deniedActions: cfg ? [...cfg.deniedActions] : [],
    allowedActions: cfg && Array.isArray(cfg.allowedActions) ? [...cfg.allowedActions] : null,
    limits,
  };
  return decision;

  function deny(code, message, user, act) {
    return {
      allowed: false,
      code,
      message,
      detail: { username: user, token: str(token), country: str(country), action: act, actionClass: classifyAction(act) },
    };
  }
}

// ---------------------------------------------------------------------------
// 违规检测（监控侧，与 collectUsers 内逻辑一致的独立入口）
// ---------------------------------------------------------------------------

export function detectViolations({ rows = [], policy, tokenUserMap = {}, days = 7, now = new Date() }) {
  const p = normalizeAccessPolicy(policy);
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const hourBuckets = new Map();
  const dayBuckets = new Map();
  const usernameByToken = new Map();
  for (const [token, username] of Object.entries({ ...(tokenUserMap || {}), ...TOKEN_USER_MAP })) {
    usernameByToken.set(str(token), str(username));
  }

  const bump = (bucketMap, username, key, type) => {
    let map = bucketMap.get(username);
    if (!map) { map = new Map(); bucketMap.set(username, map); }
    let bucket = map.get(key);
    if (!bucket) { bucket = { total: 0, creates: 0, deletes: 0, triggers: 0 }; map.set(key, bucket); }
    bucket.total += 1;
    bucket[type] = (bucket[type] || 0) + 1;
  };

  for (const raw of rows) {
    const row = normalizeAuditRow(raw);
    const ts = Date.parse(row.operationTime);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const username = usernameByToken.get(str(row.token)) || row.operator || "未知";
    const type = CREATE_METRIC_ACTIONS.has(row.action) ? "creates" : DELETE_METRIC_ACTIONS.has(row.action) ? "deletes" : TRIGGER_METRIC_ACTIONS.has(row.action) ? "triggers" : "total";
    const hKey = hourKeyOf(row.operationTime);
    const dKey = dayKeyOf(row.operationTime);
    if (hKey) bump(hourBuckets, username, hKey, type);
    if (dKey) bump(dayBuckets, username, dKey, type);
  }

  const violations = [];
  const push = (username, bucket, windowKey, windowType) => {
    const cfg = p.users[username] || null;
    const limits = mergeLimits(cfg ? cfg.limits : null, p.globalLimits);
    const checks = [
      ["maxActionsPerHour", bucket.total, "hour", "小时总操作数"],
      ["maxActionsPerDay", bucket.total, "day", "当日总操作数"],
      ["maxCreatesPerHour", bucket.creates, "hour", "小时新建数"],
      ["maxCreatesPerDay", bucket.creates, "day", "当日新建数"],
      ["maxDeletesPerDay", bucket.deletes, "day", "当日删除/禁用数"],
      ["maxTriggersPerHour", bucket.triggers, "hour", "小时触发数"],
    ];
    for (const [limitKey, actual, appliesWindow, label] of checks) {
      if (appliesWindow !== windowType) continue;
      const limit = limits[limitKey];
      if (limit != null && actual >= limit) {
        violations.push({
          username,
          metric: limitKey,
          metricLabel: label,
          limit,
          actual,
          window: windowKey,
          windowType,
          at: windowKey,
        });
      }
    }
  };

  for (const [username, map] of hourBuckets.entries()) {
    for (const [key, bucket] of map.entries()) push(username, bucket, key, "hour");
  }
  for (const [username, map] of dayBuckets.entries()) {
    for (const [key, bucket] of map.entries()) push(username, bucket, key, "day");
  }
  violations.sort((a, b) => String(b.window).localeCompare(String(a.window)));
  return violations;
}

// ---------------------------------------------------------------------------
// 生成下发给网关的 token 维度策略
// ---------------------------------------------------------------------------

export function buildGatewayPolicy({ policy, tokenUserMap = {} }) {
  const p = normalizeAccessPolicy(policy);
  const tokens = {};
  const seen = new Set();

  const addToken = (token, userEntry) => {
    const key = str(token);
    if (!key || seen.has(key)) return;
    seen.add(key);
    tokens[key] = {
      user: str(userEntry.username),
      role: userEntry.role,
      enabled: userEntry.enabled,
      allowedActions: Array.isArray(userEntry.allowedActions) ? [...userEntry.allowedActions] : null,
      deniedActions: [...(userEntry.deniedActions || [])],
      deleteAllowed: userEntry.deleteAllowed,
      limits: userEntry.limits ? { ...userEntry.limits } : {},
    };
  };

  // 1) 显式配置的用户 -> 其绑定 token
  for (const [username, entry] of Object.entries(p.users)) {
    for (const token of entry.tokens || []) addToken(token, entry);
  }
  // 2) token 映射里已知的用户 -> 按默认角色开放（避免被当作未知只读）
  for (const [token, username] of Object.entries(tokenUserMap || {})) {
    addToken(token, { username: str(username), role: p.defaultRole, enabled: true, allowedActions: null, deniedActions: [], deleteAllowed: false, limits: null });
  }
  for (const [token, username] of Object.entries(TOKEN_USER_MAP)) {
    addToken(token, { username: str(username), role: p.defaultRole, enabled: true, allowedActions: null, deniedActions: [], deleteAllowed: false, limits: null });
  }

  // 已配置但未绑定任何 token 的用户：权限到不了网关层，给出提示。
  const boundUsers = new Set(Object.values(tokens).map((t) => str(t.user)));
  const unboundUsers = Object.keys(p.users)
    .filter((name) => !boundUsers.has(str(name)))
    .map((name) => ({ username: name, role: p.users[name].role }));

  return {
    version: 1,
    enforce: p.enforcement,
    generatedAt: new Date().toISOString(),
    defaultRole: p.defaultRole,
    enforceUnknown: p.enforceUnknown,
    globalLimits: { ...p.globalLimits },
    tokens,
    warnings: unboundUsers.map((u) => ({
      code: "ACCESS_USER_NO_TOKEN",
      username: u.username,
      message: `用户 ${u.username} 未绑定任何 Token，其权限（角色 ${u.role}）无法在网关生效，仅靠未知 Token 只读兜底`,
    })),
  };
}

export async function saveGatewayPolicy(rootDir, gatewayPolicy) {
  const filePath = path.resolve(rootDir, GATEWAY_POLICY_FILE);
  await writeJsonFileAtomic(filePath, gatewayPolicy);
  return filePath;
}

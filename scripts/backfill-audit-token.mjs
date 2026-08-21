#!/usr/bin/env node
/**
 * 一次性回填脚本：从 n8n 执行历史把每次请求实际使用的 ds_token 写回审计库。
 *
 * 思路（方案 A，按 country + action + 时间近似匹配）：
 *   n8n 的执行数据里不存可用的 request_id（request_id 字段为空），但存了
 *   country / action / ds_token 以及执行时间。审计表每条记录有精确的
 *   country / action / operation_time 与唯一的 request_id。因此：
 *   1. 用 psql 从 n8n PostgreSQL 读出每条已完成执行的
 *      country、action、ds_token、执行时间（Asia/Shanghai）。
 *      n8n 执行数据是扁平数组 + 引用下标：country/action/ds_token 字段值是
 *      "下标"，真实值在 data[下标]，脚本用正则取出下标再解出真实字符串。
 *   2. 用 mysql 从审计表 ds_operation_audit_log 读出
 *      request_id、country、action、operation_time。
 *   3. 按 country 相同 + action 相同 + 执行时间≈审计时间（默认 ±30 秒）
 *      匹配，把 n8n 里真实存储的 ds_token 回填到该审计记录的
 *      request_payload.$.ds_token（只更新 token 为空/缺失的记录）。
 *
 * 注意：这是近似匹配，同一国家同一动作在同一时间窗口内有多条时可能错配。
 *
 * 前置条件（在服务器上运行，需能访问两台库）：
 *   - psql 客户端（PostgreSQL，n8n 的库；若端口未映射到宿主机，用 N8N_DOCKER_CONTAINER）
 *   - mysql 客户端（审计库）
 *   - 连接信息见下方环境变量，均可覆盖。
 *
 * 运行：
 *   node scripts/backfill-audit-token.mjs
 *   # 先试跑（不真正写库）：
 *   DRY_RUN=1 node scripts/backfill-audit-token.mjs
 *
 * 环境变量：
 *   N8N_PGHOST / N8N_PGPORT / N8N_PGUSER / N8N_PGPASSWORD / N8N_PGDATABASE
 *   N8N_DOCKER_CONTAINER（n8n Postgres 容器名，如 n8n-db；设置后通过
 *                         docker exec 在容器内跑 psql，适用于端口未映射到宿主机）
 *   N8N_WORKFLOW_NAME   （默认 ds-scheduler-router）
 *   N8N_TIMEZONE        （执行时间换算的时区，默认 Asia/Shanghai）
 *   N8N_LIMIT           （最多读取的 n8n 执行记录数，0=不限制）
 *   BACKFILL_WINDOW_MS  （时间匹配窗口，默认 30000，即 ±30 秒）
 *   AUDIT_DB_HOST / AUDIT_DB_PORT / AUDIT_DB_USER / AUDIT_DB_PASSWORD / AUDIT_DB_NAME / AUDIT_DB_TABLE
 *   AUDIT_DB_LIMIT      （最多读取的审计记录数，0=不限制）
 *   PSQL_BIN / MYSQL_BIN （客户端路径，默认 psql / mysql）
 *   DRY_RUN             （=1 只打印不写库）
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = (key, def = "") => process.env[key] || def;

const PG_TIMEOUT_MS = Math.max(5000, Number(env("N8N_PG_TIMEOUT_MS", "120000")) || 0);

const CFG = {
  pgHost: env("N8N_PGHOST", "127.0.0.1"),
  pgPort: env("N8N_PGPORT", "5432"),
  pgUser: env("N8N_PGUSER", "n8n"),
  pgPassword: env("N8N_PGPASSWORD", ""),
  pgDatabase: env("N8N_PGDATABASE", "n8n"),
  workflowName: env("N8N_WORKFLOW_NAME", "ds-scheduler-router"),
  timezone: env("N8N_TIMEZONE", "Asia/Shanghai"),
  limit: Math.max(0, Number(env("N8N_LIMIT", "0")) || 0),
  windowMs: Math.max(0, Number(env("BACKFILL_WINDOW_MS", "30000")) || 0),
  auditHost: env("AUDIT_DB_HOST", "10.20.47.19"),
  auditPort: env("AUDIT_DB_PORT", "3306"),
  auditUser: env("AUDIT_DB_USER", "root"),
  auditPassword: env("AUDIT_DB_PASSWORD", ""),
  auditDatabase: env("AUDIT_DB_NAME", "warning_rule"),
  auditTable: env("AUDIT_DB_TABLE", "ds_operation_audit_log"),
  auditLimit: Math.max(0, Number(env("AUDIT_DB_LIMIT", "0")) || 0),
  auditVia: env("AUDIT_DB_VIA", "ssh").trim().toLowerCase() || "ssh",
  auditSsh: {
    command: env("AUDIT_DB_SSH_COMMAND", "ssh"),
    host: env("AUDIT_DB_SSH_HOST", "10.20.47.14"),
    port: Number(env("AUDIT_DB_SSH_PORT", "36000")) || 22,
    user: env("AUDIT_DB_SSH_USER", "root"),
    identityFile: env("AUDIT_DB_SSH_IDENTITY_FILE", ""),
    options: env("AUDIT_DB_SSH_OPTIONS", "StrictHostKeyChecking=no,ConnectTimeout=10").split(",").map((v) => v.trim()).filter(Boolean),
  },
  psqlBin: env("PSQL_BIN", "psql"),
  mysqlBin: env("MYSQL_BIN", "mysql"),
  n8nDocker: env("N8N_DOCKER_CONTAINER", ""),
  dryRun: env("DRY_RUN", "") === "1",
};

function sqlQuote(value) {
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

function pgArgs() {
  const args = ["-h", CFG.pgHost, "-p", CFG.pgPort, "-U", CFG.pgUser, "-d", CFG.pgDatabase, "-t", "-A", "-F", "\t"];
  if (CFG.pgPassword) args.push("--no-password");
  return args;
}

async function execPg(sql) {
  const baseArgs = [...pgArgs(), "-c", sql];
  let cmd, cmdArgs, cmdEnv;
  if (CFG.n8nDocker) {
    cmd = "docker";
    cmdArgs = ["exec", "-e", `PGPASSWORD=${CFG.pgPassword}`, CFG.n8nDocker, CFG.psqlBin, ...baseArgs];
    cmdEnv = { ...process.env };
  } else {
    cmd = CFG.psqlBin;
    cmdArgs = baseArgs;
    if (CFG.pgPassword) cmdArgs.unshift("-w");
    cmdEnv = { ...process.env, PGPASSWORD: CFG.pgPassword };
  }
  const { stdout } = await run(cmd, cmdArgs, { env: cmdEnv, maxBuffer: 512 * 1024 * 1024, timeout: PG_TIMEOUT_MS });
  return stdout;
}

function unquote(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

async function readN8nRows() {
  // 每条已完成执行：取 country/action/ds_token 的引用下标，再解出真实值。
  // 执行时间换算成指定时区（默认 Asia/Shanghai，与审计 operation_time 对齐）。
  const sql = `
    SELECT
      to_char(e."startedAt" AT TIME ZONE ${sqlQuote(CFG.timezone)}, 'YYYY-MM-DD HH24:MI:SS') AS started,
      d -> (regexp_match(d::text, '"country"[[:space:]]*:[[:space:]]*"([0-9]+)"'))[1]::int AS country,
      d -> (regexp_match(d::text, '"action"[[:space:]]*:[[:space:]]*"([0-9]+)"'))[1]::int AS action,
      d -> (regexp_match(d::text, '"ds_token"[[:space:]]*:[[:space:]]*"([0-9]+)"'))[1]::int AS tok
    FROM execution_data ed
    JOIN execution_entity e ON e.id = ed."executionId"
    CROSS JOIN LATERAL (SELECT ed.data::jsonb AS d) x
    WHERE e."workflowId" = (
      SELECT id FROM workflow_entity WHERE name = ${sqlQuote(CFG.workflowName)} LIMIT 1
    ) AND e.finished = TRUE
    ${CFG.limit ? `LIMIT ${CFG.limit}` : ""};
  `;
  const stdout = await execPg(sql);
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [startedRaw, countryRaw, actionRaw, tokRaw] = line.split("\t");
    const started = unquote(startedRaw);
    const country = unquote(countryRaw).toLowerCase();
    const action = unquote(actionRaw);
    const token = unquote(tokRaw);
    if (!started || !country || !action || !token) continue;
    rows.push({ startedAt: started, country, action, token });
  }
  return rows;
}

function shQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\''`)}'`;
}

// 通过 SSH 到中国跳板机执行 mysql（与 n8n 使用统计工作流 / ZNZB 平台一致）。
// script：远端要执行的 shell 脚本；extraStdin：额外写入 ssh stdin 的数据（用于大 SQL 落盘）。
function sshExecMysql(script, extraStdin = "") {
  return new Promise((resolve, reject) => {
    const ssh = CFG.auditSsh;
    const args = [];
    if (ssh.port) args.push("-p", String(ssh.port));
    if (ssh.identityFile) args.push("-i", ssh.identityFile);
    for (const option of ssh.options) args.push("-o", option);
    args.push(`${ssh.user}@${ssh.host}`);
    const child = spawn(ssh.command, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ssh exit ${code}: ${stderr.slice(-800)}`))));
    child.stdin.write(script);
    if (extraStdin) child.stdin.write("\n" + extraStdin + "\n");
    child.stdin.end();
  });
}

function runMysqlQuery(sql) {
  const db = { host: CFG.auditHost, port: CFG.auditPort, user: CFG.auditUser, password: CFG.auditPassword, database: CFG.auditDatabase };
  if (CFG.auditVia !== "direct") {
    const script = [
      `export MYSQL_PWD=${shQuote(db.password)}`,
      `mysql --batch --raw --silent --default-character-set=utf8mb4 -h ${shQuote(db.host)} -P ${db.port} -u ${shQuote(db.user)} ${shQuote(db.database)} -e ${shQuote(sql)}`,
    ].join("\n");
    return sshExecMysql(script);
  }
  return new Promise((resolve, reject) => {
    const args = ["-h", CFG.auditHost, "-P", CFG.auditPort, "-u", CFG.auditUser, "--batch", "--raw", "--silent", "--default-character-set=utf8mb4", CFG.auditDatabase, "-e", sql];
    const child = spawn(CFG.mysqlBin, args, { env: { ...process.env, MYSQL_PWD: CFG.auditPassword } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`mysql exit ${code}: ${stderr}`))));
    child.stdin.end();
  });
}

function runMysqlExec(sql) {
  const db = { host: CFG.auditHost, port: CFG.auditPort, user: CFG.auditUser, password: CFG.auditPassword, database: CFG.auditDatabase };
  if (CFG.auditVia !== "direct") {
    const script = [
      `cat > /tmp/backfill-audit.sql`,
      `export MYSQL_PWD=${shQuote(db.password)}`,
      `mysql --default-character-set=utf8mb4 -h ${shQuote(db.host)} -P ${db.port} -u ${shQuote(db.user)} ${shQuote(db.database)} < /tmp/backfill-audit.sql`,
      `rm -f /tmp/backfill-audit.sql`,
    ].join("\n");
    return sshExecMysql(script, sql);
  }
  return new Promise((resolve, reject) => {
    const args = ["-h", CFG.auditHost, "-P", CFG.auditPort, "-u", CFG.auditUser, "--default-character-set=utf8mb4", CFG.auditDatabase];
    const child = spawn(CFG.mysqlBin, args, { env: { ...process.env, MYSQL_PWD: CFG.auditPassword } });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mysql exit ${code}: ${err}`))));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

async function readAuditRows() {
  const sql = [
    `SELECT request_id, country, action, DATE_FORMAT(operation_time, '%Y-%m-%d %H:%i:%s') AS operation_time`,
    `FROM \`${CFG.auditTable}\``,
    `WHERE request_id IS NOT NULL AND request_id <> ''`,
    CFG.auditLimit ? `LIMIT ${CFG.auditLimit}` : "",
  ].filter(Boolean).join(" ");
  const stdout = await runMysqlQuery(sql);
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [requestId, country, action, operationTime] = line.split("\t");
    rows.push({
      request_id: unquote(requestId),
      country: unquote(country).toLowerCase(),
      action: unquote(action),
      operationTime: unquote(operationTime),
    });
  }
  return rows;
}

function toTimestamp(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

async function updateAudit(n8nRows, auditRows) {
  // 建立审计记录索引：key = `${country}\u0001${action}`，值为数组（按时间）。
  const byKey = new Map();
  for (const a of auditRows) {
    const key = `${a.country}\u0001${a.action}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }

  // 逐条 n8n 记录，在对应的 country+action 桶里找时间最近且落在窗口内的审计记录。
  const matched = new Map(); // request_id -> token
  let candidates = 0;
  let unmatched = 0;
  const n8nTime = toTimestamp(n8nRows[0]?.startedAt) != null;
  for (const n of n8nRows) {
    const key = `${n.country}\u0001${n.action}`;
    const bucket = byKey.get(key);
    if (!bucket) { unmatched++; continue; }
    const t = toTimestamp(n.startedAt);
    if (t == null) { unmatched++; continue; }
    let best = null;
    let bestDiff = Infinity;
    for (const a of bucket) {
      const at = toTimestamp(a.operationTime);
      if (at == null) continue;
      const diff = Math.abs(at - t);
      if (diff <= CFG.windowMs && diff < bestDiff) {
        bestDiff = diff;
        best = a;
      }
    }
    if (best) {
      if (!matched.has(best.request_id)) matched.set(best.request_id, n.token);
      candidates++;
    } else {
      unmatched++;
    }
  }

  const statements = [];
  for (const [requestId, token] of matched.entries()) {
    statements.push(`
UPDATE ${CFG.auditTable}
SET request_payload = JSON_SET(
  COALESCE(request_payload, JSON_OBJECT()),
  '$.ds_token',
  ${sqlQuote(token)}
)
WHERE request_id = ${sqlQuote(requestId)}
  AND (
    request_payload IS NULL
    OR JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.ds_token')) IS NULL
    OR JSON_UNQUOTE(JSON_EXTRACT(request_payload, '$.ds_token')) = ''
  );`);
  }

  console.log(`[n8n]  读取 ${n8nRows.length} 条执行记录（country+action+时间可用：${n8nTime ? "是" : "否"}）`);
  console.log(`[audit] 读取 ${auditRows.length} 条审计记录`);
  console.log(`[match] 时间窗口 ±${Math.round(CFG.windowMs / 1000)} 秒；命中 ${candidates} 条，未命中 ${unmatched} 条`);
  console.log(`[audit] 唯一 request_id=${matched.size}，生成 UPDATE 语句 ${statements.length} 条`);
  if (CFG.dryRun || statements.length === 0) {
    if (statements.length === 0) console.log("[audit] 没有需要回填的记录");
    if (CFG.dryRun) console.log("[dry-run] 未执行（试跑）");
    return { updated: 0, skipped: matched.size, total: matched.size };
  }
  await runMysqlExec(statements.join("\n"));
  console.log(`[audit] 已批量执行 ${statements.length} 条 UPDATE`);
  return { updated: statements.length, skipped: 0, total: matched.size };
}

async function main() {
  if (CFG.dryRun) console.log("[mode] DRY RUN —— 不会写审计库");
  if (CFG.limit) console.log(`[limit] 本次最多读取 ${CFG.limit} 条 n8n 执行记录`);
  if (CFG.auditLimit) console.log(`[limit] 本次最多读取 ${CFG.auditLimit} 条审计记录`);
  console.log(`[n8n] ${CFG.pgHost}:${CFG.pgPort} db=${CFG.pgDatabase} workflow=${CFG.workflowName}`);
  console.log(`[audit] 访问方式=${CFG.auditVia === "direct" ? "直连 mysql" : `SSH ${CFG.auditSsh.user}@${CFG.auditSsh.host}:${CFG.auditSsh.port} → mysql ${CFG.auditHost}:${CFG.auditPort}/${CFG.auditDatabase}`}`);
  const n8nRows = await readN8nRows();
  const auditRows = await readAuditRows();
  const { updated, skipped, total } = await updateAudit(n8nRows, auditRows);
  console.log(`[audit] 唯一 request_id=${total} 已回填=${updated} 跳过=${skipped}`);
  if (CFG.dryRun) console.log("[done] 以上为试跑，未写库");
}

main().catch((error) => {
  console.error("backfill failed:", error);
  process.exit(1);
});

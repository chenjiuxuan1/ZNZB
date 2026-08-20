#!/usr/bin/env node
/**
 * 一次性回填脚本：从 n8n 执行历史把每次请求的 ds_token 写回审计库。
 *
 * 思路（方案 A）：
 *   1. 用 psql 读 n8n 自己的 PostgreSQL（execution_entity + execution_data），
 *      从路由工作流每次执行的输入项里取出 request_id 和 ds_token。
 *   2. 用 mysql 对审计表 ds_operation_audit_log 按 request_id 做 JSON_SET，
 *      把 token 写进 request_payload.$.ds_token（只更新 token 为空的记录）。
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
 *   N8N_NODE_NAMES      （逗号分隔，尝试从中提取 request_id/ds_token，
 *                         默认 "Webhook,解析并标准化请求"）
 *   N8N_LIMIT           （最多回填条数，0=不限制，便于先小批量验证）
 *   AUDIT_DB_HOST / AUDIT_DB_PORT / AUDIT_DB_USER / AUDIT_DB_PASSWORD / AUDIT_DB_NAME / AUDIT_DB_TABLE
 *   PSQL_BIN / MYSQL_BIN （客户端路径，默认 psql / mysql）
 *   DRY_RUN             （=1 只打印不写库）
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = (key, def = "") => process.env[key] || def;

const CFG = {
  pgHost: env("N8N_PGHOST", "127.0.0.1"),
  pgPort: env("N8N_PGPORT", "5432"),
  pgUser: env("N8N_PGUSER", "n8n"),
  pgPassword: env("N8N_PGPASSWORD", ""),
  pgDatabase: env("N8N_PGDATABASE", "n8n"),
  workflowName: env("N8N_WORKFLOW_NAME", "ds-scheduler-router"),
  nodeNames: env("N8N_NODE_NAMES", "Webhook,解析并标准化请求").split(",").map((v) => v.trim()).filter(Boolean),
  limit: Math.max(0, Number(env("N8N_LIMIT", "0")) || 0),
  auditHost: env("AUDIT_DB_HOST", "10.20.47.19"),
  auditPort: env("AUDIT_DB_PORT", "3306"),
  auditUser: env("AUDIT_DB_USER", "root"),
  auditPassword: env("AUDIT_DB_PASSWORD", ""),
  auditDatabase: env("AUDIT_DB_NAME", "warning_rule"),
  auditTable: env("AUDIT_DB_TABLE", "ds_operation_audit_log"),
  psqlBin: env("PSQL_BIN", "psql"),
  mysqlBin: env("MYSQL_BIN", "mysql"),
  n8nDocker: env("N8N_DOCKER_CONTAINER", ""),
  dryRun: env("DRY_RUN", "") === "1",
};

function sqlQuote(value) {
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

function pgArgs() {
  const args = ["-h", CFG.pgHost, "-p", CFG.pgPort, "-U", CFG.pgUser, "-d", CFG.pgDatabase, "-t", "-A"];
  if (CFG.pgPassword) args.push("--no-password");
  return args;
}

function pathFor(node, field) {
  return `{resultData,runData,${node},0,data,main,0,0,json,${field}}`;
}

async function readN8nRows() {
  // 每个执行只 cast 一次 data::jsonb，用 COALESCE 依次尝试多个节点名取 rid/tok。
  const ridExprs = CFG.nodeNames.map((n) => `data::jsonb #>> '${pathFor(n, "request_id")}'`);
  const tokExprs = CFG.nodeNames.map((n) => `data::jsonb #>> '${pathFor(n, "ds_token")}'`);
  const sql = `
    SELECT
      COALESCE(${ridExprs.join(", ")}),
      COALESCE(${tokExprs.join(", ")})
    FROM execution_data
    WHERE "executionId" IN (
      SELECT id FROM execution_entity
      WHERE "workflowId" = (
        SELECT id FROM workflow_entity WHERE name = ${sqlQuote(CFG.workflowName)} LIMIT 1
      ) AND finished = TRUE
    )${CFG.limit ? ` LIMIT ${CFG.limit}` : ""};
  `;
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
  const { stdout } = await run(cmd, cmdArgs, { env: cmdEnv, maxBuffer: 512 * 1024 * 1024 });
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [rid, tok] = line.split("\t");
    if (rid && tok) rows.push({ request_id: rid.trim(), token: tok.trim() });
  }
  return rows;
}

function runMysql(sql) {
  return new Promise((resolve, reject) => {
    const args = [
      "-h", CFG.auditHost, "-P", CFG.auditPort, "-u", CFG.auditUser,
      "--default-character-set=utf8mb4", CFG.auditDatabase,
    ];
    const child = spawn(CFG.mysqlBin, args, { env: { ...process.env, MYSQL_PWD: CFG.auditPassword } });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mysql exit ${code}: ${err}`))));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

async function updateAudit(rows) {
  const unique = new Map();
  for (const r of rows) {
    if (!r.token) continue;
    if (!unique.has(r.request_id)) unique.set(r.request_id, r.token);
  }
  const statements = [];
  for (const [requestId, token] of unique.entries()) {
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
  console.log(`[audit] 唯一 request_id=${unique.size}，生成 UPDATE 语句 ${statements.length} 条`);
  if (CFG.dryRun || statements.length === 0) {
    if (statements.length === 0) console.log("[audit] 没有需要回填的记录");
    return { updated: 0, skipped: unique.size, total: unique.size };
  }
  const sql = statements.join("\n");
  if (CFG.dryRun) {
    console.log("[dry-run] 未执行（试跑）");
    return { updated: 0, skipped: unique.size, total: unique.size };
  }
  await runMysql(sql);
  console.log(`[audit] 已批量执行 ${statements.length} 条 UPDATE`);
  return { updated: statements.length, skipped: 0, total: unique.size };
}

async function main() {
  if (CFG.dryRun) console.log("[mode] DRY RUN —— 不会写审计库");
  if (CFG.limit) console.log(`[limit] 本次最多处理 ${CFG.limit} 条执行记录`);
  console.log(`[n8n] ${CFG.pgHost}:${CFG.pgPort} db=${CFG.pgDatabase} workflow=${CFG.workflowName}`);
  const rows = await readN8nRows();
  console.log(`[n8n] 解析到 ${rows.length} 条带 request_id + ds_token 的执行记录`);
  const { updated, skipped, total } = await updateAudit(rows);
  console.log(`[audit] 唯一 request_id=${total} 已回填=${updated} 跳过=${skipped}`);
  if (CFG.dryRun) console.log("[done] 以上为试跑，未写库");
}

main().catch((error) => {
  console.error("backfill failed:", error);
  process.exit(1);
});

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
 *   - psql 客户端（PostgreSQL，n8n 的库）
 *   - mysql 客户端（审计库）
 *   - 相关连接信息见下方环境变量，均可通过环境变量覆盖。
 *
 * 运行：
 *   node scripts/backfill-audit-token.mjs
 *   # 先试跑（不真正写库）：
 *   DRY_RUN=1 node scripts/backfill-audit-token.mjs
 *
 * 环境变量：
 *   N8N_PGHOST / N8N_PGPORT / N8N_PGUSER / N8N_PGPASSWORD / N8N_PGDATABASE
 *   N8N_DOCKER_CONTAINER（n8n Postgres 容器名，如 n8n-db；设置后通过
 *                         docker exec 在容器内跑 psql，适用于端口未映射到宿主机的场景）
 *   N8N_WORKFLOW_NAME   （默认 ds-scheduler-router）
 *   N8N_NODE_NAMES      （逗号分隔，尝试从中提取 request_id/ds_token，
 *                         默认 "Webhook,解析并标准化请求"）
 *   AUDIT_DB_HOST / AUDIT_DB_PORT / AUDIT_DB_USER / AUDIT_DB_PASSWORD / AUDIT_DB_NAME / AUDIT_DB_TABLE
 *   PSQL_BIN / MYSQL_BIN （客户端路径，默认 psql / mysql）
 *   DRY_RUN             （=1 只打印不写库）
 */
import { execFile } from "node:child_process";
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
  auditHost: env("AUDIT_DB_HOST", "10.20.47.19"),
  auditPort: env("AUDIT_DB_PORT", "3306"),
  auditUser: env("AUDIT_DB_USER", "root"),
  auditPassword: env("AUDIT_DB_PASSWORD", ""),
  auditDatabase: env("AUDIT_DB_NAME", "warning_rule"),
  auditTable: env("AUDIT_DB_TABLE", "ds_operation_audit_log"),
  psqlBin: env("PSQL_BIN", "psql"),
  n8nDocker: env("N8N_DOCKER_CONTAINER", ""),
  mysqlBin: env("MYSQL_BIN", "mysql"),
  dryRun: env("DRY_RUN", "") === "1",
};

function sqlQuote(value) {
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
}

function pgArgs() {
  const args = [
    "-h", CFG.pgHost,
    "-p", CFG.pgPort,
    "-U", CFG.pgUser,
    "-d", CFG.pgDatabase,
    "-t", "-A",
  ];
  if (CFG.pgPassword) args.push("--no-password");
  return args;
}

async function readN8nRows() {
  const inner = CFG.nodeNames.map((node) => {
    const safeNode = node.replace(/"/g, '\\"');
    const pathRid = `{resultData,runData,${safeNode},0,data,main,0,0,json,request_id}`;
    const pathTok = `{resultData,runData,${safeNode},0,data,main,0,0,json,ds_token}`;
    return `SELECT
      data #>> '${pathRid}' AS rid,
      data #>> '${pathTok}' AS tok
    FROM execution_data
    WHERE executionId IN (
      SELECT id FROM execution_entity
      WHERE "workflowId" = (
        SELECT id FROM workflow_entity WHERE name = ${sqlQuote(CFG.workflowName)} LIMIT 1
      ) AND finished = TRUE
    )`;
  }).join("\n  UNION\n");
  const sql = `SELECT rid, tok FROM (\n  ${inner}\n) t WHERE rid IS NOT NULL AND tok IS NOT NULL AND tok <> '';`;
  const baseArgs = [...pgArgs(), "-c", sql];
  let cmd, cmdArgs, cmdEnv;
  if (CFG.n8nDocker) {
    // n8n Postgres 未映射到宿主机端口：通过 docker exec 在容器内跑 psql
    cmd = "docker";
    cmdArgs = ["exec", "-e", `PGPASSWORD=${CFG.pgPassword}`, CFG.n8nDocker, CFG.psqlBin, ...baseArgs];
    cmdEnv = { ...process.env };
  } else {
    cmd = CFG.psqlBin;
    cmdArgs = baseArgs;
    if (CFG.pgPassword) cmdArgs.unshift("-w");
    cmdEnv = { ...process.env, PGPASSWORD: CFG.pgPassword };
  }
  const { stdout } = await run(cmd, cmdArgs, {
    env: cmdEnv,
    maxBuffer: 512 * 1024 * 1024,
  });
  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [rid, tok] = line.split("\t");
    if (rid && tok) rows.push({ request_id: rid.trim(), token: tok.trim() });
  }
  return rows;
}

async function updateAudit(rows) {
  const unique = new Map();
  for (const r of rows) {
    if (!r.token) continue;
    const existing = unique.get(r.request_id);
    if (!existing) unique.set(r.request_id, r.token);
  }
  let updated = 0;
  let skipped = 0;
  for (const [requestId, token] of unique.entries()) {
    const sql = `
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
        );
    `;
    if (CFG.dryRun) {
      console.log(`[dry-run] would update request_id=${requestId} token=${token}`);
      continue;
    }
    const args = [
      "-h", CFG.auditHost, "-P", CFG.auditPort, "-u", CFG.auditUser,
      CFG.auditDatabase, "-e", sql,
    ];
    try {
      const { stdout } = await run(CFG.mysqlBin, args, {
        env: { ...process.env, MYSQL_PWD: CFG.auditPassword },
        maxBuffer: 1024 * 1024 * 8,
      });
      updated += 1;
      if (stdout && stdout.trim()) console.log(`  -> ${requestId}: ${stdout.trim()}`);
    } catch (error) {
      skipped += 1;
      console.error(`  ! failed request_id=${requestId}: ${error.message}`);
    }
  }
  return { updated, skipped, total: unique.size };
}

async function main() {
  if (CFG.dryRun) console.log("[mode] DRY RUN —— 不会写审计库");
  console.log(`[n8n] ${CFG.pgHost}:${CFG.pgPort} db=${CFG.pgDatabase} workflow=${CFG.workflowName}`);
  const rows = await readN8nRows();
  console.log(`[n8n] 解析到 ${rows.length} 条带 request_id + ds_token 的执行记录`);
  const { updated, skipped, total } = await updateAudit(rows);
  console.log(`[audit] 唯一 request_id=${total} 已回填=${updated} 失败/跳过=${skipped}`);
  if (CFG.dryRun) console.log("[done] 以上为试跑，未写库");
}

main().catch((error) => {
  console.error("backfill failed:", error);
  process.exit(1);
});

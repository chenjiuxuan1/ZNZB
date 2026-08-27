#!/usr/bin/env node
/**
 * 生成并下发 DS 网关访问控制策略到各国机器。
 *
 * 职责：
 *   1. 读取 config/ds-scheduler-access-policy.json（用户权限 + 全局限额）
 *   2. 结合 token 映射生成网关可识别的 token 维度策略
 *   3. 本地落盘 config/ds-scheduler-access-gateway.json
 *   4. （非 dry-run）SSH 将策略写入各国机器 /root/ds-scheduler-gateway/config/access_policy.json
 *
 * 用法：
 *   node scripts/publish-ds-access-policy.mjs --dry-run          # 只生成本地 + 打印下发计划
 *   node scripts/publish-ds-access-policy.mjs                    # 生成本地并下发到所有已配置国家机器
 *   node scripts/publish-ds-access-policy.mjs --countries cn,th  # 只下发指定国家
 *   node scripts/publish-ds-access-policy.mjs --target /root/ds-scheduler-gateway/config/access_policy.json
 *
 * 说明：SSH 目标复用 config/ds-scheduler.config.json usage.tokenMap.countries 中的各国主机；
 * 鉴权依赖本机已配置的 root 免密/密钥登录（与现有 token 映射拉取链路一致）。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "../src/utils.mjs";
import { buildGatewayPolicy, loadAccessPolicy, saveGatewayPolicy } from "../src/ds-scheduler-access.mjs";
import { loadDsTokenUserMap } from "../src/ds-scheduler-usage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const DEFAULT_TARGET = "/root/ds-scheduler-gateway/config/access_policy.json";

function parseArgs(argv) {
  const options = { dryRun: false, countries: [], target: DEFAULT_TARGET, port: 36000 };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--dry-run") options.dryRun = true;
    else if (item === "--countries" && argv[i + 1]) { options.countries = String(argv[i + 1]).split(",").map((c) => c.trim().toLowerCase()).filter(Boolean); i += 1; }
    else if (item === "--target" && argv[i + 1]) { options.target = argv[i + 1]; i += 1; }
  }
  return options;
}

async function loadCountriesSsh() {
  const configPath = path.join(rootDir, "config/ds-scheduler.config.json");
  let raw = null;
  try {
    raw = await readJsonFile(configPath, null);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tm = (raw && raw.usage && raw.usage.tokenMap) || {};
  const out = {};
  for (const [code, country] of Object.entries(tm.countries || {})) {
    if (country && country.ssh && country.ssh.host) {
      out[String(code).toUpperCase()] = {
        name: country.name || code,
        ssh: country.ssh,
      };
    }
  }
  return out;
}

function sshWrite(host, port, user, target, content, extraOptions = []) {
  return new Promise((resolve) => {
    const args = [];
    if (port) args.push("-p", String(port));
    for (const option of extraOptions) args.push("-o", option);
    args.push(`${user ? `${user}@` : ""}${host}`);
    args.push(`cat > ${JSON.stringify(target)}`);
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? "" : stderr.slice(0, 500) });
    });
    child.stdin.end(content);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [policy, tokenUserMap, countriesSsh] = await Promise.all([
    loadAccessPolicy(rootDir),
    loadDsTokenUserMap(rootDir),
    loadCountriesSsh(),
  ]);
  const gatewayPolicy = buildGatewayPolicy({ policy, tokenUserMap });
  const localFile = await saveGatewayPolicy(rootDir, gatewayPolicy);
  const tokenCount = Object.keys(gatewayPolicy.tokens || {}).length;
  const userCount = Object.keys(policy.users || {}).length;
  const content = `${JSON.stringify(gatewayPolicy, null, 2)}\n`;
  const targets = Object.keys(countriesSsh).length ? countriesSsh : {};
  const selected = options.countries.length
    ? Object.fromEntries(Object.entries(targets).filter(([c]) => options.countries.includes(c.toLowerCase())))
    : targets;

  console.log(`[publish] 生成网关策略: ${tokenCount} 个 Token, ${userCount} 个已配置用户, enforce=${gatewayPolicy.enforce}`);
  console.log(`[publish] 本地文件: ${localFile}`);
  console.log(`[publish] 目标路径: ${options.target}`);

  if (options.dryRun) {
    console.log("[publish] dry-run：未下发。将下发到以下机器：");
    for (const [code, country] of Object.entries(selected)) {
      console.log(`  - ${code} (${country.name}) ${country.ssh.user || "root"}@${country.ssh.host}:${country.ssh.port || 22}`);
    }
    return;
  }

  const results = [];
  for (const [code, country] of Object.entries(selected)) {
    const ssh = country.ssh || {};
    const extra = Array.isArray(ssh.options) ? ssh.options : ["StrictHostKeyChecking=no", "ConnectTimeout=10"];
    process.stdout.write(`[publish] 下发 ${code} (${country.name}) ... `);
    // eslint-disable-next-line no-await-in-loop
    const result = await sshWrite(ssh.host, ssh.port, ssh.user || "root", options.target, content, extra);
    results.push({ code, name: country.name, ...result });
    console.log(result.ok ? "OK" : `失败: ${result.error}`);
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`[publish] 完成: 成功 ${ok}/${results.length}${failed.length ? `，失败: ${failed.map((f) => f.code).join(",")}` : ""}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[publish] 失败:", error);
  process.exitCode = 1;
});

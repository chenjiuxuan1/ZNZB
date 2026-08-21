#!/usr/bin/env node
/**
 * 一次性/定期脚本：按国家 SSH 到各国机器，查询当地 DolphinScheduler 数据库的
 * t_ds_access_token + t_ds_user，构建 token -> 用户名 映射，写入
 * config/ds-token-user-map.json，供「DS网关使用统计」页展示 token（用户名）。
 *
 * 前置：config/ds-scheduler.config.json 的 usage.tokenMap 已按国家配置
 *   - ssh.host / port / user（SSH 到该国 DS 机器）
 *   - database.host / port / user / password / name（该国 DS 数据库连接，
 *     可通过环境变量注入，如 DS_PH_DB_HOST / DS_PH_DB_PASSWORD）
 *   - enabled: true
 *
 * 运行：PATH=/root/node-v16.20.2-linux-x64/bin:$PATH node scripts/refresh-token-user-map.mjs
 */
import { loadUsageConfig, fetchDsTokenUserMap, saveDsTokenUserMap, loadDsTokenUserMap } from "../src/ds-scheduler-usage.mjs";

const rootDir = process.cwd();
const config = await loadUsageConfig(rootDir);

if (!config.tokenMap || !config.tokenMap.enabled) {
  console.log("[token-map] usage.tokenMap.enabled 为 false，跳过。");
  process.exit(0);
}

console.log("[token-map] 开始按国家拉取 DS token -> 用户名 映射 ...");
const merged = await fetchDsTokenUserMap(config, (code, count, err) => {
  console.log(`[token-map] ${code}: ${err ? `失败 ${err}` : `+${count} 条`}`);
});

const previous = await loadDsTokenUserMap(rootDir);
const final = { ...previous, ...merged };
await saveDsTokenUserMap(rootDir, final);

console.log(`[token-map] 完成。本次合并后共 ${Object.keys(final).length} 个 token 映射，已写入 config/ds-token-user-map.json`);
console.log(`[token-map] 本次新增 ${Object.keys(merged).length} 条。`);

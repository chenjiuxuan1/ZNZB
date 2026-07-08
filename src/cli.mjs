#!/usr/bin/env node

import path from "node:path";
import { loadConfig } from "./config.mjs";
import { createGatewayQueryCardFn } from "./bi-gateway-client.mjs";
import { saveBrowserLogin } from "./browser-auth.mjs";
import { discoverPublicDashboards } from "./metabase-discovery.mjs";
import { checkPublicDashboards } from "./metabase-public-monitor.mjs";
import { notifyPublicCheck, notifyText } from "./notifier.mjs";
import { discover, runCheck, watch } from "./runner.mjs";
import { formatError, loadEnvFile, parseArgs, readJsonFile } from "./utils.mjs";

async function main() {
  await loadEnvFile(path.resolve(".env"));
  const { command, options } = parseArgs(process.argv);
  const configPath = options.config || "./config/monitor.config.json";

  switch (command) {
    case "login": {
      const config = await loadConfig(configPath);
      await saveBrowserLogin(config);
      return;
    }
    case "discover": {
      const config = await loadConfig(configPath);
      const result = await discover(config, options.out);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "discover-public": {
      const result = await discoverPublicDashboards({
        inputFile: options.input || "./config/discovered-panels.json",
        outputFile: options.out || "./config/discovered-public-dashboards.json",
        sampleRows: Number(options["sample-rows"] || 3),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "check-public": {
      const rulesFile = options.rules || "./config/public-monitor.config.json";
      const ruleConfig = await readJsonFile(path.resolve(rulesFile), {});
      const result = await checkPublicDashboards({
        inventoryFile: options.inventory || "./config/discovered-public-dashboards.json",
        outputFile: options.out,
        rulesFile,
        baselineCacheFile: options["baseline-cache"] || "./config/public-check-baseline-cache.json",
        queryCardFn: buildPublicQueryCardFn(options, ruleConfig),
      });
      if (options.notify) {
        await notifyPublicCheck(ruleConfig, result);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = options["exit-zero"] ? 0 : hasPublicAlert(result) ? 2 : 0;
      return;
    }
    case "notify-test": {
      const alertConfig = await readJsonFile(path.resolve(options.config || "./config/public-monitor.config.json"), {});
      await notifyText(alertConfig, options.message || "值班机器人 TV 推送测试：如果你看到这条消息，说明通道已连通。", {
        title: "值班机器人推送测试",
        severity: "info",
      });
      return;
    }
    case "check": {
      const config = await loadConfig(configPath);
      const result = await runCheck(config);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.anomalies.length > 0 ? 2 : 0;
      return;
    }
    case "watch": {
      const config = await loadConfig(configPath);
      await watch(config);
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

function hasPublicAlert(result) {
  return (result.anomalyCount || 0) > 0 || (result.dataQualityAnomalyCount || 0) > 0;
}

function buildPublicQueryCardFn(options, ruleConfig) {
  if (!shouldUseGateway(options, ruleConfig)) {
    return undefined;
  }

  const gatewayConfig = ruleConfig.gateway || {};
  const baseUrl = resolveEnvString(options["gateway-url"] || process.env.BI_GATEWAY_BASE_URL || gatewayConfig.baseUrl);
  const token = resolveEnvString(options["gateway-token"] || process.env.BI_GATEWAY_TOKEN || gatewayConfig.token || "");
  const dashcardPath = options["gateway-dashcard-path"] || gatewayConfig.dashcardPath;
  const requestTimeoutSeconds = Number(
    options["gateway-timeout-seconds"] || gatewayConfig.requestTimeoutSeconds || 60,
  );

  return createGatewayQueryCardFn({
    baseUrl,
    token,
    dashcardPath,
    requestTimeoutSeconds: Number.isFinite(requestTimeoutSeconds) ? requestTimeoutSeconds : 60,
  });
}

function shouldUseGateway(options, ruleConfig) {
  const gatewayConfig = ruleConfig.gateway || {};
  const mode = options["query-mode"] || gatewayConfig.queryMode;

  if (mode) {
    return mode === "gateway";
  }

  return Boolean(options.gateway || options["gateway-url"] || process.env.BI_GATEWAY_BASE_URL || gatewayConfig.enabled);
}

function resolveEnvString(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || "");
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});

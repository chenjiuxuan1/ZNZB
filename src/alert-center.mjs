/**
 * 告警中心聚合层。
 *
 * 拉取夜莺(nightingale) + n8n 的告警/执行数据，归一化为统一结构，
 * 供 ZNZB 的"告警中心"页面与综合监控看板使用。
 *
 * 凭据读取顺序（适配服务器部署）：
 *   1. 环境变量：N9E_BASE_URL / N9E_TOKEN / N8N_BASE_URL / N8N_API_KEY
 *   2. config/alerts.config.json（支持 ${ENV} 占位插值）
 */
import path from "node:path";
import { NightingaleClient } from "./nightingale-client.mjs";
import { N8nClient } from "./n8n-client.mjs";
import { deepMapStrings, loadEnvFile, readJsonFile } from "./utils.mjs";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;
const DEFAULT_CONFIG_FILE = "config/alerts.config.json";

/** 内联环境变量占位 ${KEY}。 */
function resolveEnv(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(ENV_PATTERN, (_, key) => process.env[key] ?? "");
}

export function createAlertCenter({ rootDir = process.cwd(), configFile } = {}) {
  const resolve = (name) => path.join(rootDir, name);

  async function loadConfig() {
    await loadEnvFile(path.join(rootDir, ".env"));
    const file = resolve(configFile || DEFAULT_CONFIG_FILE);
    const raw = await readJsonFile(file, null);
    const config = raw ? deepMapStrings(raw, resolveEnv) : {};

    const n9eBase = process.env.N9E_BASE_URL || config.nightingale?.baseUrl || "";
    const n9eToken = process.env.N9E_TOKEN || config.nightingale?.token || "";
    const n8nBase = process.env.N8N_BASE_URL || config.n8n?.baseUrl || "";
    const n8nKey = process.env.N8N_API_KEY || config.n8n?.apiKey || "";

    const nightingale = n9eBase && n9eToken
      ? new NightingaleClient({ baseUrl: n9eBase, token: n9eToken })
      : null;
    const n8n = n8nBase && n8nKey
      ? new N8nClient({ baseUrl: n8nBase, apiKey: n8nKey })
      : null;

    return { nightingale, n8n, config };
  }

  // n8n workflowId -> 名称 映射缓存（n8n 执行列表不返回名称，需从工作流列表补齐）
  const workflowNameCache = new Map();
  let workflowNameCacheAt = 0;
  const WORKFLOW_CACHE_TTL_MS = 120_000;

  async function ensureWorkflowNameMap() {
    const { n8n } = await loadConfig();
    if (!n8n) return;
    if (Date.now() - workflowNameCacheAt < WORKFLOW_CACHE_TTL_MS && workflowNameCache.size) {
      return;
    }
    try {
      // 拉取工作流建立 id -> name 映射（n8n API limit 上限 250，超出时分页拉取）
      workflowNameCache.clear();
      let cursor;
      do {
        const payload = await n8n.listWorkflows({ limit: 250, cursor });
        const list = payload?.data || [];
        for (const workflow of list) {
          if (workflow?.id) {
            workflowNameCache.set(String(workflow.id), workflow?.name || "");
          }
        }
        cursor = payload?.nextCursor || "";
      } while (cursor);
      workflowNameCacheAt = Date.now();
    } catch (error) {
      // 拉取失败时保留旧缓存；无缓存则记录时间避免反复重试
      if (!workflowNameCache.size) {
        workflowNameCacheAt = Date.now();
      }
    }
  }

  function resolveWorkflowName(execution) {
    const direct = execution?.workflowData?.name || execution?.workflowName || "";
    if (direct) return direct;
    const id = execution?.workflowId != null ? String(execution.workflowId) : "";
    if (!id) return "";
    return workflowNameCache.get(id) || "";
  }

  /** 归一化一条夜莺告警。 */
  function normalizeN9eAlert(alert) {
    const tags = {};
    for (const tag of alert?.tags || []) {
      const idx = tag.indexOf("=");
      if (idx > 0) {
        tags[tag.slice(0, idx)] = tag.slice(idx + 1);
      }
    }
    return {
      source: "nightingale",
      sourceLabel: "夜莺",
      id: alert?.id,
      ruleName: alert?.rule_name,
      ruleId: alert?.rule_id,
      groupId: alert?.group_id,
      groupName: alert?.group_name,
      severity: alert?.severity,
      severityLabel: { 0: "严重", 1: "警告", 2: "提示" }[alert?.severity] ?? String(alert?.severity),
      category: alert?.cate,
      cluster: alert?.cluster,
      datasourceId: alert?.datasource_id,
      target: alert?.target_ident || tags.ident || "",
      triggerValue: alert?.trigger_value,
      triggerTime: alert?.trigger_time ? alert.trigger_time * 1000 : null,
      isRecovered: Boolean(alert?.is_recovered),
      recoveredLabel: alert?.is_recovered ? "已恢复" : "未恢复",
      tags,
      promQl: alert?.prom_ql || "",
      sql: extractSql(alert),
      link: "",
    };
  }

  function extractSql(alert) {
    const queries = alert?.rule_config?.queries || [];
    for (const q of queries) {
      if (q?.sql) {
        return q.sql;
      }
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // 告警中心 API
  // ---------------------------------------------------------------------------

  /** 活跃告警（夜莺），归一化。 */
  async function getActiveAlerts({ busiGroup, severity, limit } = {}) {
    const { nightingale } = await loadConfig();
    if (!nightingale) {
      throw new Error("夜莺未配置：请设置 N9E_BASE_URL / N9E_TOKEN 或 config/alerts.config.json");
    }
    const list = await nightingale.getActiveAlerts({ busiGroup, severity, limit });
    return list.map(normalizeN9eAlert);
  }

  /** 历史告警（夜莺），归一化 + 分页。 */
  async function getHistoryAlerts({ stime, etime, limit = 200, page = 1, ruleName } = {}) {
    const { nightingale } = await loadConfig();
    if (!nightingale) {
      throw new Error("夜莺未配置");
    }
    const dat = await nightingale.getHistoryAlerts({ stime, etime, limit, page });
    let list = dat?.list || [];
    if (ruleName) {
      list = list.filter((item) => String(item?.rule_name).includes(String(ruleName)));
    }
    return {
      total: dat?.total || list.length,
      list: list.map(normalizeN9eAlert),
    };
  }

  /** 业务组列表。 */
  async function getBusiGroups() {
    const { nightingale } = await loadConfig();
    if (!nightingale) return [];
    return nightingale.getBusiGroups();
  }

  /** 某业务组告警规则。 */
  async function getAlertRules(busiGroup) {
    const { nightingale } = await loadConfig();
    if (!nightingale) return [];
    return nightingale.getAlertRules(busiGroup);
  }

  /** 新建夜莺告警规则。body 为规则字段。 */
  async function createAlertRule(busiGroup, body) {
    const { nightingale } = await loadConfig();
    if (!nightingale) throw new Error("夜莺未配置");
    await nightingale.createAlertRule(busiGroup, body);
    return { ok: true };
  }

  /** 更新夜莺告警规则。 */
  async function updateAlertRule(ruleId, body) {
    const { nightingale } = await loadConfig();
    if (!nightingale) throw new Error("夜莺未配置");
    await nightingale.updateAlertRule(ruleId, body);
    return { ok: true };
  }

  /** 启用/停用夜莺告警规则。 */
  async function setAlertRuleDisabled(ruleId, disabled) {
    const { nightingale } = await loadConfig();
    if (!nightingale) throw new Error("夜莺未配置");
    await nightingale.setAlertRuleDisabled(ruleId, disabled);
    return { ok: true, ruleId, disabled };
  }

  /** 数据源列表。 */
  async function getDatasources() {
    const { nightingale } = await loadConfig();
    if (!nightingale) return [];
    return nightingale.getDatasources();
  }

  /** 通知规则 + 渠道（谁接收电话/群）。 */
  async function getNotifyRules() {
    const { nightingale } = await loadConfig();
    if (!nightingale) {
      return { rules: [], channels: [] };
    }
    const [rules, channels] = await Promise.all([
      nightingale.getNotifyRules().catch(() => []),
      nightingale.getNotifyChannelConfigs().catch(() => []),
    ]);
    return { rules: Array.isArray(rules) ? rules : [], channels: Array.isArray(channels) ? channels : [] };
  }

  /** n8n 工作流列表（精简字段，前端只需展示用字段）。 */
  async function getN8nWorkflows({ active, limit = 100 } = {}) {
    const { n8n } = await loadConfig();
    if (!n8n) {
      throw new Error("n8n 未配置：请设置 N8N_BASE_URL / N8N_API_KEY 或 config/alerts.config.json");
    }
    const payload = await n8n.listWorkflows({ active, limit });
    const list = payload?.data || [];
    return list.map((workflow) => ({
      id: workflow?.id,
      name: workflow?.name,
      active: workflow?.active,
      isArchived: workflow?.isArchived,
      webhook: workflow?.webhook?.path || "",
      webhooks: (workflow?.webhooks || []).map((w) => w.path).filter(Boolean),
      updatedAt: workflow?.updatedAt || "",
    }));
  }

  /** n8n 执行记录（精简字段）。支持 status / workflowId 过滤。 */
  async function getN8nExecutions({ status, workflowId, limit = 250 } = {}) {
    const { n8n } = await loadConfig();
    if (!n8n) {
      throw new Error("n8n 未配置");
    }
    await ensureWorkflowNameMap();
    // 分页拉全量（n8n limit 上限 250），前端负责名称搜索与翻页
    const all = [];
    let cursor;
    do {
      const payload = await n8n.listExecutions({ status, workflowId, limit: Math.min(limit, 250), cursor });
      const list = payload?.data || [];
      all.push(...list);
      cursor = payload?.nextCursor || "";
      if (all.length >= 250) break;
    } while (cursor);
    return all.map((exec) => ({
      id: exec?.id,
      workflowId: exec?.workflowId,
      workflowName: resolveWorkflowName(exec),
      status: exec?.status,
      mode: exec?.mode || "",
      startedAt: exec?.startedAt || "",
      stoppedAt: exec?.stoppedAt || "",
    }));
  }

  /** n8n 执行详情：失败节点 + 错误信息 + 节点执行摘要。 */
  async function getN8nExecutionDetail(id) {
    const { n8n } = await loadConfig();
    if (!n8n) return null;
    const exec = await n8n.getExecution(id, { includeData: true });
    const rd = exec?.data?.resultData || {};
    const runData = rd?.runData || {};
    const nodes = Object.keys(runData).map((nodeName) => {
      const runs = runData[nodeName] || [];
      const first = runs[0] || {};
      return {
        name: nodeName,
        executionStatus: first?.executionStatus || "unknown",
        error: first?.error?.message || first?.error?.description || "",
        data: first?.data?.main?.[0]?.json || null,
      };
    });
    return {
      id: exec?.id,
      workflowId: exec?.workflowId,
      workflowName: exec?.workflowData?.name || resolveWorkflowName(exec) || "",
      status: exec?.status,
      startedAt: exec?.startedAt || "",
      stoppedAt: exec?.stoppedAt || "",
      lastNode: rd?.lastNodeExecuted || "",
      errorMessage: rd?.error?.message || rd?.error?.description || "",
      nodes,
    };
  }

  /** n8n 工作流启停。 */
  async function setN8nWorkflowActive(id, active) {
    const { n8n } = await loadConfig();
    if (!n8n) throw new Error("n8n 未配置");
    const updated = await n8n.updateWorkflowActive(id, active);
    // 使名称缓存失效，下次重新拉取
    workflowNameCacheAt = 0;
    return {
      id: updated?.id || id,
      name: updated?.name || "",
      active: Boolean(updated?.active),
    };
  }

  /** n8n 失败执行（含错误摘要）。 */
  async function getN8nFailedExecutions({ limit = 20 } = {}) {
    const { n8n } = await loadConfig();
    if (!n8n) return [];
    await ensureWorkflowNameMap();
    const payload = await n8n.listExecutions({ status: "error", limit });
    const list = payload?.data || [];
    return list.map((exec) => ({
      source: "n8n",
      sourceLabel: "n8n",
      id: exec?.id,
      workflowId: exec?.workflowId,
      workflowName: resolveWorkflowName(exec),
      status: exec?.status,
      startedAt: exec?.startedAt ? new Date(exec.startedAt).getTime() : null,
      stoppedAt: exec?.stoppedAt ? new Date(exec.stoppedAt).getTime() : null,
      mode: exec?.mode || "",
      failedNode: extractFailedNode(exec),
      errorMessage: extractErrorMessage(exec),
      link: "",
    }));
  }

  function extractFailedNode(execution) {
    const runData = execution?.data?.resultData?.runData || {};
    const names = Object.keys(runData);
    return names[0] || "";
  }

  function extractErrorMessage(execution) {
    const error = execution?.data?.resultData?.error;
    if (error) {
      return error.message || error.description || JSON.stringify(error).slice(0, 200);
    }
    // 从 lastNodeExecuted 附带错误里找
    const lastError = execution?.data?.resultData?.lastNodeExecuted;
    return lastError ? `lastNodeExecuted: ${lastError}` : "";
  }

  // ---------------------------------------------------------------------------
  // 综合监控看板
  // ---------------------------------------------------------------------------

  /** 三边总览：夜莺活跃告警 + n8n 失败执行 + 计数。 */
  async function getMonitorOverview() {
    const { nightingale, n8n } = await loadConfig();

    const nightingaleActive = nightingale
      ? await nightingale.getActiveAlerts({ limit: 200 }).catch(() => [])
      : [];
    const n8nFailed = n8n
      ? await n8n.listExecutions({ status: "error", limit: 50 }).catch(() => ({ data: [] }))
      : { data: [] };
    if (n8n) {
      await ensureWorkflowNameMap();
    }

    const severityCount = { 0: 0, 1: 0, 2: 0 };
    for (const alert of nightingaleActive) {
      const sev = Number(alert?.severity);
      if (sev in severityCount) severityCount[sev] += 1;
    }

    const now = Date.now();
    return {
      checkedAt: new Date(now).toISOString(),
      nightingale: {
        configured: Boolean(nightingale),
        activeCount: nightingaleActive.length,
        severityCount,
        byGroup: countByGroup(nightingaleActive),
        latest: nightingaleActive.slice(0, 10).map(normalizeN9eAlert),
      },
      n8n: {
        configured: Boolean(n8n),
        failedCount: (n8nFailed?.data || []).length,
        latest: (n8nFailed?.data || []).slice(0, 10).map((exec) => ({
          source: "n8n",
          sourceLabel: "n8n",
          id: exec?.id,
          workflowName: resolveWorkflowName(exec),
          status: exec?.status,
          startedAt: exec?.startedAt ? new Date(exec.startedAt).getTime() : null,
          errorMessage: extractErrorMessage(exec),
        })),
      },
    };
  }

  /** 活跃告警按业务组计数。 */
  function countByGroup(alerts) {
    const counter = {};
    for (const alert of alerts) {
      const key = alert?.group_name || "未知";
      counter[key] = (counter[key] || 0) + 1;
    }
    return counter;
  }

  /** 读取告警中心配置（脱敏 token）。 */
  async function getConfig() {
    const { config } = await loadConfig();
    return {
      nightingale: {
        baseUrl: config.nightingale?.baseUrl || "",
        hasToken: Boolean(process.env.N9E_TOKEN || config.nightingale?.token),
      },
      n8n: {
        baseUrl: config.n8n?.baseUrl || "",
        hasKey: Boolean(process.env.N8N_API_KEY || config.n8n?.apiKey),
      },
    };
  }

  /** 检查上游连通性。 */
  async function getHealth() {
    const { nightingale, n8n } = await loadConfig();
    return {
      nightingale: nightingale
        ? await nightingale.getBusiGroups().then(() => "ok").catch((e) => `error: ${e.message}`)
        : "not-configured",
      n8n: n8n
        ? await n8n.listWorkflows({ limit: 1 }).then(() => "ok").catch((e) => `error: ${e.message}`)
        : "not-configured",
    };
  }

  return {
    getActiveAlerts,
    getHistoryAlerts,
    getBusiGroups,
    getAlertRules,
    getDatasources,
    getNotifyRules,
    getN8nWorkflows,
    getN8nExecutions,
    getN8nFailedExecutions,
    getN8nExecutionDetail,
    setN8nWorkflowActive,
    createAlertRule,
    updateAlertRule,
    setAlertRuleDisabled,
    getMonitorOverview,
    getConfig,
    getHealth,
  };
}

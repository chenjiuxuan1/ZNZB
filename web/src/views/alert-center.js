import { apiGet } from "../api.js";
import { escapeHtml } from "../view-utils.js";

/**
 * 告警中心：综合看板（夜莺 + n8n + Grafana）+ 告警管理（查看）。
 * 手动刷新，不做定时轮询。
 */
export function renderAlertCenter(root, { reload }) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">告警中心</h1>
        <p class="page-note">综合查看夜莺、n8n、Grafana 三边告警状态。点"刷新数据"拉取最新。</p>
      </div>
      <div class="header-actions">
        <span id="ac-refresh-time" class="muted"></span>
        <button class="primary" id="ac-refresh">刷新数据</button>
      </div>
    </div>
    <div id="ac-loading" class="notice">正在加载告警数据…</div>
    <div id="ac-content"></div>
  `;

  root.querySelector("#ac-refresh").addEventListener("click", () => {
    loadData(root, reload);
  });

  loadData(root, reload);
}

async function loadData(root, reload) {
  const loading = root.querySelector("#ac-loading");
  const content = root.querySelector("#ac-content");
  loading.style.display = "";
  content.innerHTML = "";

  const [overview, config] = await Promise.all([
    apiGet("/api/alerts/overview").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/config").catch(() => ({})),
  ]);

  loading.style.display = "none";
  const timeLabel = root.querySelector("#ac-refresh-time");
  timeLabel.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;

  if (overview?.error) {
    content.innerHTML = `<div class="error">${escapeHtml(overview.error)}</div>`;
    return;
  }

  renderOverview(content, overview, config);
  renderTabs(content, reload);
}

// ---------------------------------------------------------------------------
// 综合看板
// ---------------------------------------------------------------------------

function renderOverview(root, overview, config) {
  const n9e = overview.nightingale || {};
  const n8n = overview.n8n || {};
  const sev = n9e.severityCount || {};

  root.innerHTML += `
    <div class="grid cols-3">
      <section class="panel">
        <h2 class="panel-title">夜莺活跃告警 ${config.nightingale?.hasToken ? "" : "(未配置)"}</h2>
        <div class="grid cols-2">
          ${metricCard("活跃告警", n9e.activeCount || 0)}
          ${metricCard("严重/警告/提示", `${sev[0] || 0} / ${sev[1] || 0} / ${sev[2] || 0}`)}
        </div>
        ${renderGroupBars(n9e.byGroup)}
      </section>
      <section class="panel">
        <h2 class="panel-title">n8n 失败执行 ${config.n8n?.hasKey ? "" : "(未配置)"}</h2>
        <div class="grid cols-1">
          ${metricCard("失败执行数", n8n.failedCount || 0)}
        </div>
        ${renderN8nLatest(n8n.latest)}
      </section>
      <section class="panel">
        <h2 class="panel-title">Grafana 巡检</h2>
        <p class="muted">Grafana 报表巡检沿用值班平台现有能力（总览页查看最近巡检结果）。</p>
        <p class="muted">后续可将三边告警合并推送。</p>
      </section>
    </div>
  `;
}

function metricCard(label, value) {
  return `
    <div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderGroupBars(byGroup = {}) {
  const entries = Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (!entries.length) {
    return `<p class="muted">当前无活跃告警。</p>`;
  }
  const max = Math.max(...entries.map(([, count]) => count));
  return `
    <h3 class="section-title">按业务组</h3>
    <div class="bar-list">
      ${entries.map(([name, count]) => `
        <div class="bar-row">
          <span class="bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(8, (count / max) * 100)}%"></div></div>
          <span class="bar-count">${count}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderN8nLatest(latest = []) {
  if (!latest.length) {
    return `<p class="muted">无失败执行。</p>`;
  }
  return `
    <h3 class="section-title">最近失败执行</h3>
    <ul class="plain-list">
      ${latest.map((exec) => `
        <li>
          <strong>${escapeHtml(exec.workflowName || `#${exec.id}`)}</strong>
          <span class="muted"> ${escapeHtml(formatTime(exec.startedAt))}</span>
          ${exec.errorMessage ? `<div class="muted small">${escapeHtml(exec.errorMessage).slice(0, 120)}</div>` : ""}
        </li>
      `).join("")}
    </ul>
  `;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function renderTabs(root, reload) {
  const tabs = [
    { key: "active", label: "活跃告警" },
    { key: "history", label: "历史告警" },
    { key: "rules", label: "告警规则" },
    { key: "notify", label: "通知规则" },
    { key: "n8n-workflows", label: "n8n工作流" },
    { key: "n8n-executions", label: "n8n执行" },
  ];

  root.innerHTML += `
    <div class="tabs" id="ac-tabs">
      ${tabs.map((tab) => `<button class="tab-btn" data-tab="${tab.key}">${tab.label}</button>`).join("")}
    </div>
    <div id="ac-tab-content" class="tab-content"></div>
  `;

  root.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      root.querySelectorAll("[data-tab]").forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      switchTab(root, button.dataset.tab, reload);
    });
  });

  // 默认打开第一个 tab
  root.querySelector('[data-tab="active"]').classList.add("active");
  switchTab(root, "active", reload);
}

async function switchTab(root, tab, reload) {
  const container = root.querySelector("#ac-tab-content");
  container.innerHTML = `<div class="notice">加载中…</div>`;
  try {
    if (tab === "active") {
      const list = await apiGet("/api/alerts/active");
      container.innerHTML = renderActiveList(list);
    } else if (tab === "history") {
      container.innerHTML = renderHistoryForm();
      await loadHistory(container);
    } else if (tab === "rules") {
      container.innerHTML = renderRulesForm();
      await loadRules(container);
    } else if (tab === "notify") {
      const data = await apiGet("/api/alerts/notify-rules");
      container.innerHTML = renderNotifyRules(data);
    } else if (tab === "n8n-workflows") {
      const list = await apiGet("/api/alerts/n8n/workflows");
      container.innerHTML = renderN8nWorkflows(list);
    } else if (tab === "n8n-executions") {
      const list = await apiGet("/api/alerts/n8n/executions?status=error&limit=50");
      container.innerHTML = renderN8nExecutions(list);
    }
    bindTabEvents(root, tab, container);
  } catch (error) {
    container.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function bindTabEvents(root, tab, container) {
  if (tab === "history") {
    container.querySelector("#history-load")?.addEventListener("click", () => loadHistory(container));
  }
  if (tab === "rules") {
    container.querySelector("#rules-load")?.addEventListener("click", () => loadRules(container));
  }
}

// ---------------------------------------------------------------------------
// 活跃告警
// ---------------------------------------------------------------------------

function renderActiveList(list) {
  if (!list.length) {
    return `<p class="muted">当前没有活跃告警。</p>`;
  }
  return `
    <table class="data-table">
      <thead>
        <tr>
          <th>来源</th><th>级别</th><th>规则</th><th>业务组</th>
          <th>目标</th><th>触发值</th><th>触发时间</th><th>状态</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((alert) => `
          <tr>
            <td><span class="badge">${alert.sourceLabel}</span></td>
            <td><span class="badge ${severityClass(alert.severity)}">${alert.severityLabel}</span></td>
            <td title="${escapeHtml(alert.sql || alert.promQl || "")}">${escapeHtml(alert.ruleName || "-")}</td>
            <td>${escapeHtml(alert.groupName || "-")}</td>
            <td>${escapeHtml(alert.target || "-")}</td>
            <td>${escapeHtml(alert.triggerValue ?? "-")}</td>
            <td>${escapeHtml(formatTime(alert.triggerTime))}</td>
            <td><span class="badge ${alert.isRecovered ? "ok" : "warn"}">${alert.recoveredLabel}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// 历史告警
// ---------------------------------------------------------------------------

function renderHistoryForm() {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600 * 1000);
  return `
    <div class="filter-bar">
      <label>起始 <input type="datetime-local" id="history-from" value="${toLocalInput(from)}"></label>
      <label>结束 <input type="datetime-local" id="history-to" value="${toLocalInput(now)}"></label>
      <label>规则名 <input type="text" id="history-rule" placeholder="可选"></label>
      <button class="primary" id="history-load">查询</button>
    </div>
    <div id="history-result"></div>
  `;
}

async function loadHistory(container) {
  const result = container.querySelector("#history-result");
  result.innerHTML = `<div class="notice">加载中…</div>`;
  const from = container.querySelector("#history-from")?.value;
  const to = container.querySelector("#history-to")?.value;
  const ruleName = container.querySelector("#history-rule")?.value;
  try {
    const payload = await apiGet(buildHistoryUrl(from, to, ruleName));
    const list = payload.list || [];
    if (!list.length) {
      result.innerHTML = `<p class="muted">该时段没有历史告警（共 ${payload.total || 0} 条匹配）。</p>`;
      return;
    }
    result.innerHTML = `
      <p class="muted">共 ${payload.total} 条，展示最近 ${list.length} 条</p>
      <table class="data-table">
        <thead><tr><th>级别</th><th>规则</th><th>业务组</th><th>触发值</th><th>触发时间</th><th>状态</th></tr></thead>
        <tbody>
          ${list.map((alert) => `
            <tr>
              <td><span class="badge ${severityClass(alert.severity)}">${alert.severityLabel}</span></td>
              <td title="${escapeHtml(alert.sql || "")}">${escapeHtml(alert.ruleName || "-")}</td>
              <td>${escapeHtml(alert.groupName || "-")}</td>
              <td>${escapeHtml(alert.triggerValue ?? "-")}</td>
              <td>${escapeHtml(formatTime(alert.triggerTime))}</td>
              <td><span class="badge ${alert.isRecovered ? "ok" : "warn"}">${alert.recoveredLabel}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    result.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function buildHistoryUrl(fromValue, toValue, ruleName) {
  const params = new URLSearchParams();
  if (fromValue) params.set("stime", String(Math.floor(new Date(fromValue).getTime() / 1000)));
  if (toValue) params.set("etime", String(Math.floor(new Date(toValue).getTime() / 1000)));
  params.set("limit", "100");
  if (ruleName) params.set("ruleName", ruleName);
  return `/api/alerts/history?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 告警规则
// ---------------------------------------------------------------------------

function renderRulesForm() {
  return `
    <div class="filter-bar">
      <label>业务组 <input type="number" id="rules-bg" placeholder="留空=全部拉取(慢)"></label>
      <button class="primary" id="rules-load">查询规则</button>
    </div>
    <div id="rules-result"></div>
  `;
}

async function loadRules(container) {
  const result = container.querySelector("#rules-result");
  result.innerHTML = `<div class="notice">加载中…</div>`;
  const bg = container.querySelector("#rules-bg")?.value;
  try {
    // 若无业务组则从夜莺拉全部业务组，逐个查询（仅取启用规则概要）
    let rules = [];
    if (bg) {
      rules = await apiGet(`/api/alerts/rules?busiGroup=${bg}`);
    } else {
      const groups = await apiGet("/api/alerts/busi-groups");
      for (const group of groups.slice(0, 18)) {
        const groupRules = await apiGet(`/api/alerts/rules?busiGroup=${group.id}`);
        rules = rules.concat(groupRules);
      }
    }
    const activeRules = rules.filter((rule) => !rule.disabled);
    result.innerHTML = `
      <p class="muted">共 ${rules.length} 条（启用 ${activeRules.length}）</p>
      <table class="data-table">
        <thead><tr><th>规则名</th><th>业务组</th><th>类型</th><th>生效</th><th>通知规则</th><th>状态</th></tr></thead>
        <tbody>
          ${rules.map((rule) => `
            <tr>
              <td title="${escapeHtml(extractSqlFromRule(rule))}">${escapeHtml(rule.name || rule.rule_name || "-")}</td>
              <td>${escapeHtml(rule.group_name || rule.busi_group_name || "-")}</td>
              <td>${escapeHtml(rule.cate || rule.prod || "-")}</td>
              <td>${escapeHtml(rule.enable_stime || rule.rule_config?.enable_stime || "-")}~${escapeHtml(rule.enable_etime || rule.rule_config?.enable_etime || "-")}</td>
              <td>${escapeHtml(String(rule.notify_rule_ids || ""))}</td>
              <td><span class="badge ${rule.disabled ? "warn" : "ok"}">${rule.disabled ? "禁用" : "启用"}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    result.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function extractSqlFromRule(rule) {
  const queries = rule.rule_config?.queries || [];
  for (const q of queries) {
    if (q?.sql) return q.sql;
    if (q?.prom_ql) return q.prom_ql;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 通知规则
// ---------------------------------------------------------------------------

function renderNotifyRules(data) {
  const rules = data.rules || [];
  const channels = data.channels || [];
  const channelMap = {};
  for (const channel of channels) {
    channelMap[String(channel.id)] = channel.ident || channel.name || `渠道#${channel.id}`;
  }
  if (!rules.length) {
    return `<p class="muted">无通知规则。</p>`;
  }
  return `
    <p class="muted">通知规则 ${rules.length} 条 · 通知渠道 ${channels.length} 个（含 ivr 电话）</p>
    <table class="data-table">
      <thead><tr><th>通知规则</th><th>渠道</th><th>接收人</th><th>启用</th></tr></thead>
      <tbody>
        ${rules.map((rule) => {
          const configs = rule.notify_configs || [];
          const channelLabels = configs.map((config) => channelMap[String(config.channel_id)] || `#${config.channel_id}`).join("、");
          const userIds = [...new Set(configs.flatMap((config) => config.params?.user_ids || []))];
          return `
            <tr>
              <td>${escapeHtml(rule.name || "-")}</td>
              <td>${escapeHtml(channelLabels || "-")}</td>
              <td>${escapeHtml(userIds.join("、") || "-")}</td>
              <td><span class="badge ${rule.enable ? "ok" : "warn"}">${rule.enable ? "启用" : "禁用"}</span></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// n8n
// ---------------------------------------------------------------------------

function renderN8nWorkflows(list) {
  if (!list.length) {
    return `<p class="muted">无工作流。</p>`;
  }
  return `
    <p class="muted">共 ${list.length} 个工作流</p>
    <table class="data-table">
      <thead><tr><th>名称</th><th>ID</th><th>激活</th><th>webhook</th></tr></thead>
      <tbody>
        ${list.map((workflow) => `
          <tr>
            <td>${escapeHtml(workflow.name || "-")}</td>
            <td>${escapeHtml(String(workflow.id || ""))}</td>
            <td><span class="badge ${workflow.active ? "ok" : "warn"}">${workflow.active ? "激活" : "未激活"}</span></td>
            <td>${escapeHtml(workflow.webhook?.path || workflow.webhooks?.map((w) => w.path).join("、") || "-")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderN8nExecutions(list) {
  if (!list.length) {
    return `<p class="muted">无执行记录（当前为失败执行视图）。</p>`;
  }
  return `
    <p class="muted">最近失败执行 ${list.length} 条</p>
    <table class="data-table">
      <thead><tr><th>ID</th><th>工作流</th><th>状态</th><th>开始时间</th><th>错误</th></tr></thead>
      <tbody>
        ${list.map((exec) => `
          <tr>
            <td>${escapeHtml(String(exec.id || ""))}</td>
            <td>${escapeHtml(exec.workflowData?.name || exec.workflowName || `#${exec.workflowId}` || "-")}</td>
            <td><span class="badge warn">${escapeHtml(exec.status || "-")}</span></td>
            <td>${escapeHtml(formatIso(exec.startedAt))}</td>
            <td class="small">${escapeHtml(exec.error || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function severityClass(severity) {
  const map = { 0: "critical", 1: "warn", 2: "ok" };
  return map[severity] || "";
}

function formatTime(ms) {
  if (!ms) return "-";
  const date = new Date(ms);
  return isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function formatIso(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour12: false });
}

function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

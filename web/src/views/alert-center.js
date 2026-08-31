import { apiGet } from "../api.js";
import { escapeHtml } from "../view-utils.js";

/**
 * 告警中心：告警实时看板。
 *
 * 形态参考 Wattrel 告警页面（实时看板样式）：
 *   - hero 统计卡片：当前告警 / 涉及业务组 / 严重告警 / n8n失败 / 更新时间
 *   - 按业务组卡片展示当前活跃告警，点击卡片查看该组明细
 *   - n8n 最近失败执行
 * 手动刷新，不做定时轮询。
 */
export function renderAlertCenter(root, { reload }) {
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">告警中心</h1>
        <p class="page-note">实时查看夜莺当前活跃告警，按业务组聚合展示；n8n 失败执行一目了然。点"刷新真实数据"拉取最新。</p>
      </div>
      ${renderHeroStats(null)}
    </div>

    <section class="panel wattrel-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">当前告警看板</h2>
          <p class="muted">实时查询夜莺活跃告警，按业务组聚合；点击业务组卡片查看该组当前告警明细。</p>
        </div>
        <div class="wattrel-button-row">
          <button id="ac-refresh" class="primary">刷新真实数据</button>
        </div>
      </div>
      <div id="ac-status"></div>
      <div id="ac-content"><div class="notice">正在加载告警数据…</div></div>
    </section>
  `;

  root.querySelector("#ac-refresh").addEventListener("click", () => {
    loadData(root, reload);
  });

  loadData(root, reload);
}

async function loadData(root, reload) {
  const statusEl = root.querySelector("#ac-status");
  const content = root.querySelector("#ac-content");
  setStatus(statusEl, "loading", "正在查询当前告警", "正在实时拉取夜莺活跃告警与 n8n 失败执行。");

  const [overview, active, config] = await Promise.all([
    apiGet("/api/alerts/overview").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/active?limit=200").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/config").catch(() => ({})),
  ]);

  if (overview?.error || active?.error) {
    const message = overview?.error || active?.error;
    setStatus(statusEl, "error", "告警实时查询失败", "请检查夜莺/n8n 凭据与网络（配置见 .env）。");
    content.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
    return;
  }

  const timeLabel = formatDateTime(new Date().toISOString());
  const stats = buildStats(overview, active, config);
  renderHeroStats(stats, true);
  setStatus(statusEl, "success",
    (stats.activeCount || 0) > 0 ? "当前告警已更新" : "当前无活跃告警",
    `${stats.activeCount || 0} 条活跃告警，涉及 ${stats.groupCount || 0} 个业务组，n8n 失败执行 ${stats.failedCount || 0} 条。${timeLabel}`);

  renderContent(root, content, overview, active, stats);
}

function buildStats(overview, active, config) {
  const n9e = overview.nightingale || {};
  const n8n = overview.n8n || {};
  const activeList = Array.isArray(active) ? active : [];
  const byGroup = n9e.byGroup || {};
  const sev = n9e.severityCount || {};
  const severity0 = activeList.filter((a) => Number(a.severity) === 0).length || sev[0] || 0;
  return {
    activeCount: n9e.activeCount || activeList.length || 0,
    groupCount: Object.keys(byGroup).length || 0,
    severity0,
    severity1: sev[1] || 0,
    severity2: sev[2] || 0,
    failedCount: n8n.failedCount || 0,
    checkedAt: overview.checkedAt || new Date().toISOString(),
    n9eConfigured: Boolean(config.nightingale?.hasToken) || n9e.configured,
    n8nConfigured: Boolean(config.n8n?.hasKey) || n8n.configured,
  };
}

function renderHeroStats(stats, show = false) {
  const el = document.querySelector?.("#ac-hero-stats");
  const host = document.querySelector?.(".page-header.batch-hero") || null;
  if (!show || !stats) {
    return "";
  }
  const markup = `
    <div id="ac-hero-stats" class="hero-stats" aria-label="告警中心概览">
      <article><span>当前告警</span><strong>${escapeHtml(stats.activeCount)}</strong></article>
      <article><span>涉及业务组</span><strong>${escapeHtml(stats.groupCount)}</strong></article>
      <article><span>严重告警</span><strong>${escapeHtml(stats.severity0)}</strong></article>
      <article><span>n8n失败执行</span><strong>${escapeHtml(stats.failedCount)}</strong></article>
      <article><span>更新时间</span><strong>${escapeHtml(formatTimeShort(stats.checkedAt))}</strong></article>
    </div>
  `;
  if (el) {
    el.outerHTML = markup;
  } else if (host) {
    host.insertAdjacentHTML("beforeend", markup);
  }
  return markup;
}

function setStatus(el, type, title, detail) {
  if (!el) return;
  el.innerHTML = `
    <div class="sandbox-status ${escapeHtml(type)}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail || "")}</span>
    </div>
  `;
}

function renderContent(root, content, overview, active, stats) {
  const activeList = Array.isArray(active) ? active : [];
  const byGroup = buildGroupMap(activeList, overview);

  if (!byGroup.size) {
    content.innerHTML = `
      <div class="auto-summary">
        ${summaryItem("当前告警", 0)}
        ${summaryItem("业务组", 0)}
        ${summaryItem("n8n失败", stats.failedCount || 0)}
      </div>
      <p class="${stats.n9eConfigured ? "success" : "muted"}">${stats.n9eConfigured ? "已连接的业务组当前没有活跃告警。" : "夜莺未配置凭据（N9E_BASE_URL/N9E_TOKEN），无法查询活跃告警。"}</p>
      ${renderN8nFailures(overview.n8n || {})}
    `;
    return;
  }

  content.innerHTML = `
    <div class="auto-summary">
      ${summaryItem("当前告警", stats.activeCount)}
      ${summaryItem("业务组", byGroup.size)}
      ${summaryItem("严重告警", stats.severity0)}
      ${summaryItem("n8n失败", stats.failedCount)}
    </div>
    ${renderGroupGrid(byGroup)}
    ${renderGroupDetail(byGroup)}
    ${renderN8nFailures(overview.n8n || {})}
  `;

  root.querySelectorAll("[data-ac-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = button.getAttribute("data-ac-group") || "";
      root.querySelectorAll("[data-ac-group]").forEach((b) => b.classList.remove("is-selected"));
      button.classList.add("is-selected");
      const detail = root.querySelector("#ac-group-detail");
      if (detail) {
        detail.innerHTML = renderGroupDetailRows(byGroup.get(group) || []);
      }
    });
  });
}

function buildGroupMap(activeList, overview) {
  const map = new Map();
  for (const alert of activeList) {
    const group = alert.groupName || "未归属";
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(alert);
  }
  // 合并 overview.byGroup 里未出现在 activeList 的组
  const byGroup = overview.nightingale?.byGroup || {};
  for (const [name, count] of Object.entries(byGroup)) {
    if (!map.has(name)) {
      map.set(name, Array.from({ length: Math.min(count, 10) }, (_, i) => ({
        ruleName: `${name} 告警${i + 1}`,
        groupName: name,
        severity: null,
        severityLabel: "未知",
        target: "",
        triggerTime: null,
        source: "夜莺",
      })));
    }
  }
  return map;
}

function renderGroupGrid(byGroup) {
  const entries = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
  return `
    <section class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">按业务组当前告警</h2>
          <p class="muted">点击业务组卡片查看该组当前告警明细。</p>
        </div>
      </div>
      <div class="wattrel-country-grid">
        ${entries.map(([name, alerts]) => {
          const sev0 = alerts.filter((a) => Number(a.severity) === 0).length;
          return `
            <button type="button" class="wattrel-country-card" data-ac-group="${escapeHtml(name)}">
              <div>
                <strong>${escapeHtml(name)}</strong>
                <span>${sev0 ? `严重 ${sev0} 条 · ` : ""}共 ${alerts.length} 条告警</span>
              </div>
              <p>${escapeHtml(alerts.slice(0, 3).map((a) => a.ruleName || "告警").join("，") || "暂无明细")}</p>
              <small>查看明细</small>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderGroupDetail(byGroup) {
  return `
    <section class="sub-panel" id="ac-group-detail-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">告警明细</h2>
          <p class="muted">点击上方业务组卡片，这里展示该组的当前告警明细。</p>
        </div>
      </div>
      <div id="ac-group-detail">${renderGroupDetailRows(byGroup.values().next().value || [])}</div>
    </section>
  `;
}

function renderGroupDetailRows(alerts) {
  if (!alerts || !alerts.length) {
    return `<p class="muted">该业务组当前没有告警明细。</p>`;
  }
  return `
    <table class="data-table">
      <thead>
        <tr><th>级别</th><th>规则</th><th>目标</th><th>触发值</th><th>触发时间</th><th>状态</th></tr>
      </thead>
      <tbody>
        ${alerts.slice(0, 50).map((alert) => `
          <tr>
            <td><span class="badge ${severityClass(alert.severity)}">${escapeHtml(alert.severityLabel || "-")}</span></td>
            <td title="${escapeHtml(alert.sql || alert.promQl || "")}">${escapeHtml(alert.ruleName || "-")}</td>
            <td>${escapeHtml(alert.target || "-")}</td>
            <td>${escapeHtml(alert.triggerValue ?? "-")}</td>
            <td>${escapeHtml(formatTime(alert.triggerTime))}</td>
            <td><span class="badge ${alert.isRecovered ? "ok" : "warn"}">${escapeHtml(alert.recoveredLabel || "-")}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderN8nFailures(n8n) {
  const latest = n8n.latest || [];
  return `
    <section class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">n8n 最近失败执行</h2>
          <p class="muted">展示 n8n 最近失败的工作流执行（${escapeHtml(n8n.failedCount || 0)} 条失败）。</p>
        </div>
      </div>
      ${latest.length ? `
        <table class="data-table">
          <thead><tr><th>工作流</th><th>状态</th><th>开始时间</th><th>错误</th></tr></thead>
          <tbody>
            ${latest.slice(0, 20).map((exec) => `
              <tr>
                <td>${escapeHtml(exec.workflowName || `#${exec.id}` || "-")}</td>
                <td><span class="badge warn">${escapeHtml(exec.status || "error")}</span></td>
                <td>${escapeHtml(formatIso(exec.startedAt))}</td>
                <td class="small">${escapeHtml(exec.errorMessage || exec.error || "").slice(0, 160)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<p class="muted">${n8n.configured ? "当前没有 n8n 失败执行。" : "n8n 未配置凭据（N8N_BASE_URL/N8N_API_KEY）。"}</p>`}
    </section>
  `;
}

function summaryItem(label, value) {
  return `
    <div class="info-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
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

function formatTimeShort(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return isNaN(date.getTime()) ? "-" : date.toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

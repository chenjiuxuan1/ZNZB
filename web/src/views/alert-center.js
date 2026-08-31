import { apiGet } from "../api.js";
import { escapeHtml } from "../view-utils.js";

/**
 * 告警中心：告警实时看板。
 *
 * 形态参考 Wattrel 告警页面（实时看板样式）：
 *   - hero 统计卡片：当前告警 / 涉及业务组 / 严重告警 / n8n失败 / 更新时间
 *   - 按业务组卡片展示当前活跃告警，点击卡片查看该组明细
 *   - n8n 最近失败执行
 *
 * 渲染策略：页面首次仅输出骨架，数据加载完成后一次性写入完整内容，
 * 避免多次 innerHTML 导致页面连续闪烁。手动刷新，不做定时轮询。
 */
export function renderAlertCenter(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">告警中心</h1>
        <p class="page-note">实时查看夜莺当前活跃告警，按业务组聚合展示；n8n 失败执行一目了然。点"刷新真实数据"拉取最新。</p>
      </div>
      <div class="header-actions">
        <span id="ac-refresh-time" class="muted"></span>
        <button class="primary" id="ac-refresh">刷新真实数据</button>
      </div>
    </div>
    <section class="panel wattrel-panel">
      <div id="ac-body" class="notice">正在加载告警数据…</div>
    </section>
  `;

  root.querySelector("#ac-refresh").addEventListener("click", () => {
    loadData(root);
  });

  loadData(root);
}

async function loadData(root) {
  const body = root.querySelector("#ac-body");
  const refreshTime = root.querySelector("#ac-refresh-time");
  body.innerHTML = `<div class="notice">正在加载告警数据…</div>`;

  const [overview, active, config] = await Promise.all([
    apiGet("/api/alerts/overview").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/active?limit=200").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/config").catch(() => ({})),
  ]);

  if (refreshTime) {
    refreshTime.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
  }

  if (overview?.error || active?.error) {
    const message = overview?.error || active?.error;
    body.innerHTML = `
      <div class="sandbox-status error">
        <strong>告警实时查询失败</strong>
        <span>请检查夜莺/n8n 凭据与网络（配置见 .env）。</span>
      </div>
      <div class="error">${escapeHtml(message)}</div>
    `;
    return;
  }

  // 一次性渲染全部内容（hero + 状态 + 看板），避免多次重绘闪烁
  body.innerHTML = renderBody(overview, active, config);
  bindGroupClicks(root);
}

function renderBody(overview, active, config) {
  const stats = buildStats(overview, active, config);
  const activeList = Array.isArray(active) ? active : [];
  const byGroup = buildGroupMap(activeList, overview);
  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);

  return `
    <div class="hero-stats" aria-label="告警中心概览">
      <article><span>当前告警</span><strong>${escapeHtml(stats.activeCount)}</strong></article>
      <article><span>涉及业务组</span><strong>${escapeHtml(stats.groupCount)}</strong></article>
      <article><span>严重告警</span><strong>${escapeHtml(stats.severity0)}</strong></article>
      <article><span>n8n失败执行</span><strong>${escapeHtml(stats.failedCount)}</strong></article>
      <article><span>更新时间</span><strong>${escapeHtml(formatTimeShort(stats.checkedAt))}</strong></article>
    </div>

    <div class="sandbox-status ${stats.activeCount ? "success" : "info"}">
      <strong>${stats.activeCount ? "当前告警已更新" : "当前无活跃告警"}</strong>
      <span>${stats.activeCount || 0} 条活跃告警，涉及 ${stats.groupCount || 0} 个业务组，n8n 失败执行 ${stats.failedCount || 0} 条。</span>
    </div>

    <div class="auto-summary">
      ${summaryItem("当前告警", stats.activeCount)}
      ${summaryItem("业务组", groups.length)}
      ${summaryItem("严重告警", stats.severity0)}
      ${summaryItem("n8n失败", stats.failedCount)}
    </div>

    ${renderGroupGrid(groups)}
    ${renderGroupDetail(groups)}
    ${renderN8nFailures(overview.n8n || {})}
  `;
}

function buildStats(overview, active, config) {
  const n9e = overview.nightingale || {};
  const n8n = overview.n8n || {};
  const activeList = Array.isArray(active) ? active : [];
  const sev = n9e.severityCount || {};
  const severity0 = activeList.filter((a) => Number(a.severity) === 0).length || sev[0] || 0;
  return {
    activeCount: n9e.activeCount || activeList.length || 0,
    groupCount: Object.keys(n9e.byGroup || {}).length,
    severity0,
    severity1: sev[1] || 0,
    severity2: sev[2] || 0,
    failedCount: n8n.failedCount || 0,
    checkedAt: overview.checkedAt || new Date().toISOString(),
  };
}

function buildGroupMap(activeList, overview) {
  const map = new Map();
  for (const alert of activeList) {
    const group = alert.groupName || "未归属";
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(alert);
  }
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

function renderGroupGrid(groups) {
  if (!groups.length) {
    return "";
  }
  return `
    <section class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">按业务组当前告警</h2>
          <p class="muted">点击业务组卡片查看该组当前告警明细。</p>
        </div>
      </div>
      <div class="wattrel-country-grid">
        ${groups.map(([name, alerts]) => {
          const sev0 = alerts.filter((a) => Number(a.severity) === 0).length;
          const alertsJson = escapeHtml(JSON.stringify(alerts).replace(/"/g, "&quot;"));
          return `
            <button type="button" class="wattrel-country-card" data-ac-group="${escapeHtml(name)}" data-ac-alerts="${alertsJson}">
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

function renderGroupDetail(groups) {
  if (!groups.length) {
    return "";
  }
  return `
    <section class="sub-panel" id="ac-group-detail-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">告警明细</h2>
          <p class="muted">点击上方业务组卡片，这里展示该组的当前告警明细。</p>
        </div>
      </div>
      <div id="ac-group-detail">${renderGroupDetailRows(groups[0]?.[1] || [])}</div>
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
      ` : `<p class="muted">当前没有 n8n 失败执行。</p>`}
    </section>
  `;
}

function bindGroupClicks(root) {
  const detail = root.querySelector("#ac-group-detail");
  if (!detail) return;
  const map = new Map();
  root.querySelectorAll("[data-ac-group]").forEach((button) => {
    const group = button.getAttribute("data-ac-group") || "";
    button.addEventListener("click", () => {
      root.querySelectorAll("[data-ac-group]").forEach((b) => b.classList.remove("is-selected"));
      button.classList.add("is-selected");
      const alerts = getGroupAlerts(root, group);
      detail.innerHTML = renderGroupDetailRows(alerts);
    });
  });
}

function getGroupAlerts(root, group) {
  // 从按钮的 data 属性缓存读取该组告警
  const button = root.querySelector(`[data-ac-group="${CSS.escape(group)}"]`);
  const payload = button?.dataset;
  if (!payload) return [];
  try {
    const list = JSON.parse(payload.acAlerts || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
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

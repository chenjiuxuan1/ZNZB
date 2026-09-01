import { apiGet, apiPost } from "../api.js";
import { escapeHtml } from "../view-utils.js";

// 业务组 -> 告警列表 缓存（点击卡片查看明细时读取；不用 data 属性存 JSON，避免转义损坏）
let acGroupData = new Map();

/**
 * 告警中心：实时看板 + 配置管理。
 *
 * Tabs:
 *   1. 实时看板 - hero 统计 + 业务组告警 + n8n 失败执行（搜索/筛选/分页/展开详情）
 *   2. 配置管理 - 夜莺告警规则（新建/编辑/启停）+ n8n 工作流（启停）
 *
 * 设计（taste-skill / redesign 方法）：内部运维监控看板，
 * 克制数据可视化语言，tabular-nums + 语义色 + 轻动效。
 * DESIGN_VARIANCE 5 / MOTION_INTENSITY 4 / VISUAL_DENSITY 7。
 */
export function renderAlertCenter(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">告警中心</h1>
        <p class="page-note">实时查看夜莺与 n8n 告警状态，并可配置告警规则与工作流。点"刷新"拉取最新。</p>
      </div>
      <div class="header-actions">
        <span id="ac-refresh-time" class="muted"></span>
        <button class="primary" id="ac-refresh">刷新数据</button>
      </div>
    </div>
    <div class="ac-tabs">
      <button class="ac-tab active" data-ac-tab="dashboard">实时看板</button>
      <button class="ac-tab" data-ac-tab="config">配置管理</button>
    </div>
    <section class="panel ac-panel">
      <div id="ac-body"></div>
    </section>
  `;

  root.querySelector("#ac-refresh").addEventListener("click", () => {
    const tab = root.querySelector(".ac-tab.active")?.dataset.acTab || "dashboard";
    loadTab(root, tab);
  });

  root.querySelectorAll(".ac-tab").forEach((button) => {
    button.addEventListener("click", () => {
      root.querySelectorAll(".ac-tab").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      loadTab(root, button.dataset.acTab);
    });
  });

  loadTab(root, "dashboard");
}

// ---------------------------------------------------------------------------
// Tab 调度
// ---------------------------------------------------------------------------

async function loadTab(root, tab) {
  const body = root.querySelector("#ac-body");
  const refreshTime = root.querySelector("#ac-refresh-time");
  body.innerHTML = `<div class="notice">正在加载…</div>`;
  try {
    if (tab === "dashboard") {
      await loadDashboard(root, body, refreshTime);
    } else if (tab === "config") {
      await loadConfigTab(root, body, refreshTime);
    }
  } catch (error) {
    body.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
  }
}

// ---------------------------------------------------------------------------
// 实时看板 Tab
// ---------------------------------------------------------------------------

async function loadDashboard(root, body, refreshTime) {
  const [overview, active, config] = await Promise.all([
    apiGet("/api/alerts/overview").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/active?limit=200").catch((error) => ({ error: error.message })),
    apiGet("/api/alerts/config").catch(() => ({})),
  ]);
  if (refreshTime) refreshTime.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;

  if (overview?.error || active?.error) {
    const message = overview?.error || active?.error;
    body.innerHTML = `
      <div class="sandbox-status error"><strong>告警实时查询失败</strong><span>请检查夜莺/n8n 凭据与网络（配置见 .env）。</span></div>
      <div class="error">${escapeHtml(message)}</div>
    `;
    return;
  }

  body.innerHTML = renderDashboard(overview, active, config);
  bindDashboardEvents(root, body);
}

function renderDashboard(overview, active, config) {
  const stats = buildStats(overview, active, config);
  const activeList = Array.isArray(active) ? active : [];
  const byGroup = buildGroupMap(activeList, overview);
  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
  // 填充点击缓存：group 名 -> 告警列表
  acGroupData = new Map(groups);

  return `
    ${renderHero(stats)}

    <div class="sandbox-status ${stats.activeCount ? "success" : "info"}">
      <strong>${stats.activeCount ? "当前告警已更新" : "当前无活跃告警"}</strong>
      <span>${stats.activeCount || 0} 条活跃告警，涉及 ${stats.groupCount || 0} 个业务组，n8n 失败执行 ${stats.failedCount || 0} 条。</span>
    </div>

    ${renderGroupGrid(groups)}
    ${renderGroupDetail(groups)}
    ${renderN8nFailuresPanel(overview.n8n || {}, stats.failedCount || 0)}
  `;
}

function bindDashboardEvents(root, body) {
  // 业务组卡片点击
  body.querySelectorAll("[data-ac-group]").forEach((button) => {
    button.addEventListener("click", () => {
      body.querySelectorAll("[data-ac-group]").forEach((b) => b.classList.remove("is-selected"));
      button.classList.add("is-selected");
      const detail = body.querySelector("#ac-group-detail");
      if (detail) detail.innerHTML = renderGroupDetailRows(getGroupAlerts(button.dataset.acGroup));
    });
  });
  // n8n 失败执行：加载列表
  bindN8nList(root, body);
}

// ---------------------------------------------------------------------------
// Hero 统计
// ---------------------------------------------------------------------------

function renderHero(stats) {
  const hasCritical = Number(stats.severity0) > 0;
  return `
    <div class="ac-hero" aria-label="告警中心概览">
      <div class="ac-hero-primary ${hasCritical ? "is-critical" : ""}">
        <span class="ac-hero-label">当前活跃告警</span>
        <strong class="ac-hero-value">${escapeHtml(stats.activeCount)}</strong>
        <span class="ac-hero-sub">涉及 ${escapeHtml(stats.groupCount)} 个业务组</span>
      </div>
      <div class="ac-hero-cell">
        <span class="ac-hero-label">严重告警</span>
        <strong class="ac-hero-value ${hasCritical ? "text-danger" : ""}">${escapeHtml(stats.severity0)}</strong>
        <span class="ac-hero-sub">严重级别 P0</span>
      </div>
      <div class="ac-hero-cell">
        <span class="ac-hero-label">警告告警</span>
        <strong class="ac-hero-value text-warn">${escapeHtml(stats.severity1)}</strong>
        <span class="ac-hero-sub">警告级别 P1</span>
      </div>
      <div class="ac-hero-cell">
        <span class="ac-hero-label">n8n 失败执行</span>
        <strong class="ac-hero-value ${stats.failedCount ? "text-danger" : ""}">${escapeHtml(stats.failedCount)}</strong>
        <span class="ac-hero-sub">最近失败工作流</span>
      </div>
      <div class="ac-hero-cell">
        <span class="ac-hero-label">更新时间</span>
        <strong class="ac-hero-value ac-hero-time">${escapeHtml(formatTimeShort(stats.checkedAt))}</strong>
        <span class="ac-hero-sub">手动刷新</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// 业务组
// ---------------------------------------------------------------------------

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
  if (!groups.length) return "";
  return `
    <section class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">按业务组当前告警</h2>
          <p class="muted">点击业务组卡片查看该组当前告警明细。</p>
        </div>
      </div>
      <div class="ac-group-grid">
        ${groups.map(([name, alerts]) => {
          const sev0 = alerts.filter((a) => Number(a.severity) === 0).length;
          return `
            <button type="button" class="ac-group-card ${sev0 ? "has-critical" : ""}" data-ac-group="${escapeHtml(name)}">
              <div class="ac-group-card-head">
                <strong>${escapeHtml(name)}</strong>
                <span class="ac-group-count">${alerts.length}</span>
              </div>
              <p class="ac-group-preview">${escapeHtml(alerts.slice(0, 3).map((a) => a.ruleName || "告警").join("，") || "暂无明细")}</p>
              <div class="ac-group-meta">
                ${sev0 ? `<span class="pill danger">严重 ${sev0}</span>` : ""}
                <span class="ac-group-detail-link">查看明细 →</span>
              </div>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderGroupDetail(groups) {
  if (!groups.length) return "";
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
  if (!alerts || !alerts.length) return `<p class="muted">该业务组当前没有告警明细。</p>`;
  return `
    <table class="data-table ac-alert-table">
      <thead>
        <tr><th>级别</th><th>规则 / 含义</th><th>国家</th><th>目标</th><th>触发值</th><th>触发时间</th><th>状态</th></tr>
      </thead>
      <tbody>
        ${alerts.slice(0, 50).map((alert) => `
          <tr>
            <td><span class="badge ${severityClass(alert.severity)}">${escapeHtml(alert.severityLabel || "-")}</span></td>
            <td>
              <strong>${escapeHtml(alert.ruleName || "-")}</strong>
              ${alert.meaning ? `<div class="ac-alert-meaning" title="${escapeHtml(alert.meaning)}">${escapeHtml(alert.meaning)}</div>` : ""}
              ${alert.suggestion ? `<div class="ac-alert-action">建议：${escapeHtml(alert.suggestion)}</div>` : ""}
            </td>
            <td>
              ${alert.country && alert.country !== "未知" ? `<span class="badge country">${escapeHtml(alert.country)}</span>` : `<span class="muted">-</span>`}
            </td>
            <td class="small">${escapeHtml(alert.target || "-")}</td>
            <td class="num">${escapeHtml(alert.triggerValue ?? "-")}</td>
            <td class="num">${escapeHtml(formatTime(alert.triggerTime))}</td>
            <td><span class="badge ${alert.isRecovered ? "ok" : "warn"}">${escapeHtml(alert.recoveredLabel || "-")}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function getGroupAlerts(groupName) {
  if (!groupName) return [];
  return acGroupData.get(groupName) || [];
}

// ---------------------------------------------------------------------------
// n8n 失败执行：搜索 / 筛选 / 分页 / 展开详情
// ---------------------------------------------------------------------------

function renderN8nFailuresPanel(n8n, failedCount) {
  return `
    <section class="sub-panel" id="ac-n8n-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">n8n 失败执行</h2>
          <p class="muted">${failedCount} 条失败。支持搜索、按工作流筛选、分页；点击行展开失败详情。</p>
        </div>
        ${failedCount ? `<span class="pill danger">${escapeHtml(failedCount)} 条失败</span>` : ""}
      </div>
      <div class="ac-filter-bar">
        <input type="text" id="ac-n8n-search" class="ac-search-input" placeholder="搜索工作流名称…">
        <select id="ac-n8n-workflow-filter" class="ac-search-input">
          <option value="">全部工作流</option>
        </select>
        <button class="primary small" id="ac-n8n-load">查询</button>
        <span id="ac-n8n-total" class="muted"></span>
      </div>
      <div id="ac-n8n-table"></div>
      <div class="ac-pager" id="ac-n8n-pager"></div>
    </section>
  `;
}

const N8N_PAGE_SIZE = 15;

async function bindN8nList(root, body) {
  const tableEl = body.querySelector("#ac-n8n-table");
  const pagerEl = body.querySelector("#ac-n8n-pager");
  const totalEl = body.querySelector("#ac-n8n-total");
  const searchEl = body.querySelector("#ac-n8n-search");
  const filterEl = body.querySelector("#ac-n8n-workflow-filter");
  const loadBtn = body.querySelector("#ac-n8n-load");
  if (!tableEl) return;

  let all = [];
  let page = 1;
  const state = { search: "", workflowId: "" };

  async function fetchList() {
    tableEl.innerHTML = `<div class="notice">加载 n8n 执行…</div>`;
    try {
      const [execs, workflows] = await Promise.all([
        apiGet(`/api/alerts/n8n/executions?status=error&limit=250`),
        apiGet(`/api/alerts/n8n/workflows?limit=250`).catch(() => []),
      ]);
      all = execs;
      // 筛选下拉：全部工作流（不只失败的），用户可筛出"某工作流当前无失败"
      const workflowMap = new Map();
      for (const wf of Array.isArray(workflows) ? workflows : []) {
        if (wf.id && wf.name) workflowMap.set(String(wf.id), wf.name);
      }
      for (const exec of all) {
        if (exec.workflowId && exec.workflowName && !workflowMap.has(String(exec.workflowId))) {
          workflowMap.set(String(exec.workflowId), exec.workflowName);
        }
      }
      const current = filterEl.value;
      filterEl.innerHTML = `<option value="">全部工作流</option>` +
        [...workflowMap.entries()].sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
      filterEl.value = current || "";
    } catch (error) {
      all = [];
      tableEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
    applyFilters();
  }

  function applyFilters() {
    const search = state.search.toLowerCase();
    const filtered = all.filter((exec) => {
      if (state.workflowId && String(exec.workflowId) !== String(state.workflowId)) return false;
      if (search) {
        const name = String(exec.workflowName || "").toLowerCase();
        const id = String(exec.id || "");
        if (!name.includes(search) && !id.includes(search)) return false;
      }
      return true;
    });
    totalEl.textContent = `共 ${filtered.length} 条`;
    page = 1;
    renderPage(filtered);
  }

  function renderPage(filtered) {
    const start = (page - 1) * N8N_PAGE_SIZE;
    const rows = filtered.slice(start, start + N8N_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(filtered.length / N8N_PAGE_SIZE));
    tableEl.innerHTML = rows.length ? `
      <table class="data-table">
        <thead><tr><th>工作流</th><th>状态</th><th>开始时间</th><th>失败节点</th></tr></thead>
        <tbody>
          ${rows.map((exec) => `
            <tr class="ac-exec-row" data-exec-id="${escapeHtml(String(exec.id))}" data-exec-wf="${escapeHtml(exec.workflowName || "")}" data-exec-status="${escapeHtml(exec.status || "")}">
              <td>${escapeHtml(exec.workflowName || `#${exec.id}`)}</td>
              <td><span class="badge danger">${escapeHtml(exec.status || "error")}</span></td>
              <td class="num">${escapeHtml(formatIso(exec.startedAt))}</td>
              <td class="small muted">点击查看</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : `<p class="muted">没有匹配的失败执行。</p>`;

    // 分页
    pagerEl.innerHTML = `
      <button class="small" id="ac-n8n-prev" ${page <= 1 ? "disabled" : ""}>上一页</button>
      <span class="muted">第 ${page} / ${totalPages} 页</span>
      <button class="small" id="ac-n8n-next" ${page >= totalPages ? "disabled" : ""}>下一页</button>
    `;
    pagerEl.querySelector("#ac-n8n-prev")?.addEventListener("click", () => { if (page > 1) { page--; renderPage(filtered); } });
    pagerEl.querySelector("#ac-n8n-next")?.addEventListener("click", () => { if (page < totalPages) { page++; renderPage(filtered); } });

    // 行点击 -> 弹窗详情
    tableEl.querySelectorAll(".ac-exec-row").forEach((row) => {
      row.addEventListener("click", () => openExecutionDetail(row.dataset.execId, root));
    });
  }

  searchEl?.addEventListener("input", () => { state.search = searchEl.value.trim(); applyFilters(); });
  filterEl?.addEventListener("change", () => { state.workflowId = filterEl.value; applyFilters(); });
  loadBtn?.addEventListener("click", () => { all = []; fetchList(); });

  await fetchList();
}

async function openExecutionDetail(id, root) {
  const existing = document.getElementById("ac-exec-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "ac-exec-modal";
  overlay.className = "ac-modal-overlay";
  overlay.innerHTML = `
    <div class="ac-modal" role="dialog" aria-modal="true" aria-label="执行详情">
      <div class="ac-modal-head">
        <strong>执行详情</strong>
        <button class="ac-modal-close" aria-label="关闭">✕</button>
      </div>
      <div class="ac-modal-body"><div class="notice">加载执行 #${escapeHtml(String(id))} 详情…</div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.classList.add("show");

  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 180); };
  overlay.querySelector(".ac-modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", function onEsc(event) {
    if (event.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  const bodyEl = overlay.querySelector(".ac-modal-body");
  try {
    const data = await apiGet(`/api/alerts/n8n/executions/detail?id=${encodeURIComponent(id)}`);
    bodyEl.innerHTML = `
      <div class="ac-exec-detail-head">
        <div>
          <strong>${escapeHtml(data.workflowName || `#${data.id}`)}</strong>
          <span class="muted"> 执行 #${escapeHtml(String(data.id))} · ${escapeHtml(formatIso(data.startedAt))}</span>
        </div>
        <span class="badge danger">${escapeHtml(data.status || "error")}</span>
      </div>
      ${data.errorMessage ? `<div class="sandbox-status error"><strong>错误</strong><span>${escapeHtml(data.errorMessage)}</span></div>` : ""}
      <div class="ac-exec-nodes">
        ${(data.nodes || []).map((node) => `
          <div class="ac-exec-node ${node.executionStatus === "error" ? "is-error" : ""}">
            <span class="ac-exec-node-name">${escapeHtml(node.name)}</span>
            <span class="badge ${node.executionStatus === "error" ? "danger" : "ok"}">${escapeHtml(node.executionStatus || "-")}</span>
            ${node.error ? `<div class="muted small">${escapeHtml(node.error)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  } catch (error) {
    bodyEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 配置管理 Tab
// ---------------------------------------------------------------------------

async function loadConfigTab(root, body, refreshTime) {
  if (refreshTime) refreshTime.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
  const [groups, config] = await Promise.all([
    apiGet("/api/alerts/busi-groups").catch(() => []),
    apiGet("/api/alerts/config").catch(() => ({})),
  ]);
  body.innerHTML = renderConfigTab(groups, config);
  bindConfigEvents(root, body, groups);
}

function renderConfigTab(groups, config) {
  const groupOptions = (groups || []).map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("");
  return `
    <div class="ac-config-grid">
      <section class="sub-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">夜莺告警规则</h2>
            <p class="muted">选择业务组查看规则；可启用/停用规则（配置编辑在夜莺端操作）。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <label>业务组
            <select id="ac-rules-bg" class="ac-search-input">${groupOptions}</select>
          </label>
          <button class="primary small" id="ac-rules-load">加载规则</button>
        </div>
        <div id="ac-rules-table"></div>
      </section>
      <section class="sub-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">n8n 工作流</h2>
            <p class="muted">查看工作流状态，可启用/停用激活。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <label>状态
            <select id="ac-wf-filter" class="ac-search-input">
              <option value="">全部</option>
              <option value="true">已激活</option>
              <option value="false">未激活</option>
            </select>
          </label>
          <button class="primary small" id="ac-wf-load">加载工作流</button>
        </div>
        <div id="ac-wf-table"></div>
      </section>
    </div>
  `;
}

async function bindConfigEvents(root, body, groups) {
  // 夜莺规则
  const rulesLoad = body.querySelector("#ac-rules-load");
  const rulesTable = body.querySelector("#ac-rules-table");
  const bgSelect = body.querySelector("#ac-rules-bg");
  if (rulesLoad && bgSelect) {
    const loadRules = async () => {
      const bg = bgSelect.value;
      if (!bg) { rulesTable.innerHTML = `<p class="muted">请选择业务组。</p>`; return; }
      rulesTable.innerHTML = `<div class="notice">加载规则…</div>`;
      try {
        const rules = await apiGet(`/api/alerts/rules?busiGroup=${bg}`);
        rulesTable.innerHTML = renderRulesTable(rules);
        rulesTable.querySelectorAll("[data-rule-toggle]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const ruleId = btn.dataset.ruleToggle;
            const disabled = btn.dataset.disabled === "1";
            try {
              await apiPost(`/api/alerts/rules/${ruleId}`, { disabled: !disabled ? 1 : 0 });
              await loadRules();
            } catch (error) {
              rulesTable.innerHTML += `<div class="error">${escapeHtml(error.message)}</div>`;
            }
          });
        });
      } catch (error) {
        rulesTable.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    };
    rulesLoad.addEventListener("click", loadRules);
    loadRules();
  }

  // n8n 工作流
  const wfLoad = body.querySelector("#ac-wf-load");
  const wfTable = body.querySelector("#ac-wf-table");
  const wfFilter = body.querySelector("#ac-wf-filter");
  if (wfLoad) {
    const loadWorkflows = async () => {
      wfTable.innerHTML = `<div class="notice">加载工作流…</div>`;
      try {
        const active = wfFilter.value === "" ? undefined : wfFilter.value === "true";
        const query = active === undefined ? "?limit=250" : `?active=${active}&limit=250`;
        const list = await apiGet(`/api/alerts/n8n/workflows${query}`);
        wfTable.innerHTML = renderWorkflowsTable(list);
        wfTable.querySelectorAll("[data-wf-toggle]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.dataset.wfToggle;
            const activeNow = btn.dataset.active === "true";
            btn.disabled = true;
            try {
              await apiPost("/api/alerts/n8n/workflows/toggle", { id, active: !activeNow });
              await loadWorkflows();
            } catch (error) {
              btn.disabled = false;
              wfTable.innerHTML += `<div class="error">${escapeHtml(error.message)}</div>`;
            }
          });
        });
      } catch (error) {
        wfTable.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    };
    wfLoad.addEventListener("click", loadWorkflows);
    wfFilter.addEventListener("change", loadWorkflows);
    loadWorkflows();
  }
}

function renderRulesTable(rules) {
  if (!rules.length) return `<p class="muted">该业务组暂无告警规则。</p>`;
  return `
    <table class="data-table">
      <thead><tr><th>规则名</th><th>类型</th><th>级别</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
        ${rules.map((rule) => `
          <tr>
            <td title="${escapeHtml(extractRuleQuery(rule))}">${escapeHtml(rule.name || "-")}</td>
            <td>${escapeHtml(rule.cate || rule.prod || "-")}</td>
            <td><span class="badge ${severityClass(rule.severity)}">${escapeHtml(severityLabel(rule.severity))}</span></td>
            <td><span class="badge ${rule.disabled ? "warn" : "ok"}">${rule.disabled ? "已停用" : "启用"}</span></td>
            <td>
              <button class="small ${rule.disabled ? "primary" : ""}" data-rule-toggle="${escapeHtml(String(rule.id))}" data-disabled="${escapeHtml(String(rule.disabled || 0))}">
                ${rule.disabled ? "启用" : "停用"}
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderWorkflowsTable(list) {
  if (!list.length) return `<p class="muted">暂无工作流。</p>`;
  return `
    <table class="data-table">
      <thead><tr><th>工作流名称</th><th>激活</th><th>webhook</th><th>操作</th></tr></thead>
      <tbody>
        ${list.map((wf) => `
          <tr>
            <td>${escapeHtml(wf.name || `#${wf.id}`)}</td>
            <td><span class="badge ${wf.active ? "ok" : "warn"}">${wf.active ? "已激活" : "未激活"}</span></td>
            <td class="small muted">${escapeHtml(wf.webhook?.path || wf.webhooks?.map((w) => w.path).join("、") || "-")}</td>
            <td>
              <button class="small ${wf.active ? "" : "primary"}" data-wf-toggle="${escapeHtml(String(wf.id))}" data-active="${wf.active ? "true" : "false"}">
                ${wf.active ? "停用" : "启用"}
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function extractRuleQuery(rule) {
  const queries = rule.rule_config?.queries || [];
  for (const q of queries) {
    if (q?.sql) return q.sql;
    if (q?.prom_ql) return q.prom_ql;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

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

function severityClass(severity) {
  const map = { 0: "critical", 1: "warn", 2: "ok" };
  return map[severity] || "";
}

function severityLabel(severity) {
  return { 0: "严重", 1: "警告", 2: "提示" }[severity] ?? String(severity ?? "-");
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

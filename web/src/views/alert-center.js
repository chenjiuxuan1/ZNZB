import { apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

// 业务组 -> 告警列表 缓存（点击卡片查看明细时读取；不用 data 属性存 JSON，避免转义损坏）
let acGroupData = new Map();
// 当前告警明细列表（点击行打开详情弹窗时读取）
let acDetailAlerts = [];
// 配置管理：规则 / 目标 缓存（编辑表单回填用）
let acRulesCache = [];
let acTargetsCache = [];
let acDatasourcesCache = [];
let acWorkflowsCache = [];
// 配置管理分页状态：{ key: currentPage }
const acPages = { rules: 1, targets: 1, datasources: 1, workflows: 1 };
// 配置管理搜索词
const acSearch = { targets: "", workflows: "" };
// 配置管理每页条数
const AC_PAGE_SIZE = 20;

/** 通用分页条 HTML。 */
function renderAcPager(id, page, pageCount, total, searched) {
  if (!total) return "";
  const max = Math.max(pageCount, 1);
  const safePage = Math.min(Math.max(page, 1), max);
  return `
    <div class="ac-pager" data-pager="${id}" data-page="${safePage}" data-max="${max}">
      <span class="muted">共 ${total} 条${searched ? "（当前筛选后）" : ""} · 第 ${safePage}/${max} 页</span>
      <div>
        <button class="small" data-pg="prev" ${safePage <= 1 ? "disabled" : ""}>上一页</button>
        <button class="small" data-pg="next" ${safePage >= max ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `;
}

/** 通用分页事件：事件委托，data-pager 指定区块，翻页后回调重新渲染。 */
/** 通用分页事件：事件委托到 document，DOM 重建后依然有效。
 *  pager 元素的 data-pager 作为 key，回调注册到 acPagerHandlers。 */
const acPagerHandlers = {};
function bindAcPagerEvents(pager, onPageChange) {
  if (!pager) return;
  // pager 是外层容器（#ac-xxx-pager），data-pager 在内部 .ac-pager 上
  const key = pager.querySelector("[data-pager]")?.dataset.pager || pager.id || pager.dataset.pager;
  acPagerHandlers[key] = onPageChange;
  if (!document.__acPagerBound) {
    document.__acPagerBound = true;
    document.addEventListener("click", (event) => {
      const btn = event.target.closest?.("[data-pg]");
      if (!btn) return;
      const pagerEl = btn.closest?.("[data-pager]");
      if (!pagerEl) return;
      const handler = acPagerHandlers[pagerEl.dataset.pager];
      if (!handler) return;
      const page = Number(pagerEl.dataset.page);
      const max = Number(pagerEl.dataset.max);
      const dir = btn.dataset.pg;
      if (dir === "prev" && page > 1) handler(page - 1);
      else if (dir === "next" && page < max) handler(page + 1);
    });
  }
}

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
  // UI 原型：?variant=A|B|C 切换不同布局（prototype skill 子形状A，浮动底部切换条）
  const variant = readVariantParam();
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
      <button class="ac-tab" data-ac-tab="history">告警日志</button>
      <button class="ac-tab" data-ac-tab="config">配置管理</button>
    </div>
    <section class="panel ac-panel">
      <div id="ac-body"></div>
    </section>
    ${variant ? renderVariantSwitcher(variant) : ""}
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

  if (variant) bindVariantSwitcher(root);

  loadTab(root, "dashboard");
}

/** 从 hash 解析 ?variant= 参数（#/alerts?variant=A）。 */
function readVariantParam() {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex === -1) return "";
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  const v = params.get("variant");
  return v && ["A", "B", "C"].includes(v) ? v : "";
}

/** 浮动切换条（prototype 用，非最终 UI）。 */
function renderVariantSwitcher(current) {
  const names = { A: "A · 分栏工作台", B: "B · 卡片仪表盘", C: "C · 极简聚焦" };
  return `
    <div class="ac-variant-bar" role="navigation" aria-label="布局变体切换">
      <button class="ac-variant-prev" aria-label="上一个变体">←</button>
      <span class="ac-variant-label">${escapeHtml(names[current])}</span>
      <button class="ac-variant-next" aria-label="下一个变体">→</button>
      <button class="ac-variant-close" aria-label="退出原型模式">✕ 退出原型</button>
    </div>
  `;
}

/** 绑定切换条：左右箭头循环切换，关闭则移除 variant 参数。 */
function bindVariantSwitcher(root) {
  const order = ["A", "B", "C"];
  const next = (current, delta) => order[(order.indexOf(current) + delta + order.length) % order.length];
  const switchTo = (v) => {
    const hash = window.location.hash || "#/alerts";
    const qIndex = hash.indexOf("?");
    const base = qIndex === -1 ? hash : hash.slice(0, qIndex);
    window.location.hash = `${base}?variant=${v}`;
    // hash 变化触发路由重渲染
  };
  root.querySelector(".ac-variant-prev")?.addEventListener("click", () => {
    switchTo(next(readVariantParam(), -1));
  });
  root.querySelector(".ac-variant-next")?.addEventListener("click", () => {
    switchTo(next(readVariantParam(), 1));
  });
  root.querySelector(".ac-variant-close")?.addEventListener("click", () => {
    const hash = window.location.hash || "#/alerts";
    const qIndex = hash.indexOf("?");
    window.location.hash = qIndex === -1 ? hash : hash.slice(0, qIndex);
  });
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
    } else if (tab === "history") {
      await loadHistoryTab(root, body, refreshTime);
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

  body.innerHTML = renderDashboard(overview, active, config, readVariantParam());
  bindDashboardEvents(root, body);
}

function renderDashboard(overview, active, config, variant) {
  const stats = buildStats(overview, active, config);
  const activeList = Array.isArray(active) ? active : [];
  const byGroup = buildGroupMap(activeList, overview);
  const groups = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length);
  // 填充点击缓存：group 名 -> 告警列表
  acGroupData = new Map(groups);

  if (variant === "A") return renderVariantA(stats, groups, overview, activeList);
  if (variant === "B") return renderVariantB(stats, groups, overview, activeList);
  if (variant === "C") return renderVariantC(stats, groups, overview, activeList, config);

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
      if (detail) {
        detail.innerHTML = renderGroupDetailRows(getGroupAlerts(button.dataset.acGroup));
        bindAlertRows(detail);
      }
    });
  });
  // 初始告警明细行（默认第一个业务组）
  const initialDetail = body.querySelector("#ac-group-detail");
  if (initialDetail) bindAlertRows(initialDetail);
  // 变体 C：表格行不在 #ac-group-detail 内，单独绑定
  body.querySelectorAll("table.ac-alert-table .ac-alert-row").forEach((row) => {
    if (row.closest("#ac-group-detail")) return;
    row.addEventListener("click", () => openAlertDetail(acDetailAlerts[Number(row.dataset.alertIdx)]));
  });
  // n8n 失败执行：加载列表
  bindN8nList(root, body);
}

// 告警明细行点击 -> 详情弹窗
function bindAlertRows(container) {
  container.querySelectorAll(".ac-alert-row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = Number(row.dataset.alertIdx);
      const alert = acDetailAlerts[idx];
      if (alert) openAlertDetail(alert);
    });
  });
}

/** 打开告警详情弹窗：规则配置 + 通知配置（支持启停/编辑接收人）。 */
async function openAlertDetail(alert) {
  const existing = document.getElementById("ac-alert-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "ac-alert-modal";
  overlay.className = "ac-modal-overlay";
  overlay.innerHTML = `
    <div class="ac-modal ac-alert-modal" role="dialog" aria-modal="true" aria-label="告警详情">
      <div class="ac-modal-head">
        <strong>${escapeHtml(alert.ruleName || "告警详情")}</strong>
        <button class="ac-modal-close" aria-label="关闭">✕</button>
      </div>
      <div class="ac-modal-body">
        <div class="ac-alert-detail-head">
          <span class="badge ${severityClass(alert.severity)}">${escapeHtml(alert.severityLabel || "-")}</span>
          ${alert.country && alert.country !== "未知" ? `<span class="badge country">${escapeHtml(alert.country)}</span>` : ""}
          <span class="muted">${escapeHtml(alert.target || "-")} · ${escapeHtml(formatTime(alert.triggerTime))}</span>
        </div>
        <div class="ac-alert-detail-block">
          <h4>告警说明</h4>
          <p>${escapeHtml(alert.meaning || "-")}</p>
          <p class="ac-alert-action">建议：${escapeHtml(alert.suggestion || "-")}</p>
        </div>
        <div class="ac-alert-detail-block">
          <h4>规则配置</h4>
          <div class="ac-kv">
            <span class="ac-kv-label">类型</span><span>${escapeHtml(alert.category || "-")}</span>
            <span class="ac-kv-label">触发值</span><span class="num">${escapeHtml(alert.triggerValue ?? "-")}</span>
            <span class="ac-kv-label">触发时间</span><span>${escapeHtml(formatTime(alert.triggerTime))}</span>
            <span class="ac-kv-label">状态</span><span>${escapeHtml(alert.recoveredLabel || "-")}</span>
          </div>
          ${alert.promQl ? `<div class="ac-kv"><span class="ac-kv-label">PromQL</span><code>${escapeHtml(alert.promQl)}</code></div>` : ""}
          ${alert.sql ? `<div class="ac-kv"><span class="ac-kv-label">SQL</span><code>${escapeHtml(alert.sql.slice(0, 500))}${alert.sql.length > 500 ? "…" : ""}</code></div>` : ""}
        </div>
        <div class="ac-alert-detail-block">
          <h4>通知方式与地址</h4>
          <div id="ac-alert-notify-list">
            ${renderNotifyDetail(alert.notify)}
          </div>
        </div>
      </div>
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
  bindNotifyActions(overlay, alert);
}

/** 渲染通知规则详情列表。 */
function renderNotifyDetail(notify) {
  if (!notify || !notify.length) return `<p class="muted">该规则未配置通知。</p>`;
  return notify.map((nr) => `
    <div class="ac-notify-rule">
      <div class="ac-notify-rule-head">
        <strong>${escapeHtml(nr.ruleName || "通知规则")}</strong>
        <span class="badge ${nr.enable ? "ok" : "warn"}">${nr.enable ? "启用" : "停用"}</span>
        <button class="small ac-notify-toggle" data-nr-id="${escapeHtml(String(nr.ruleId))}" data-nr-enable="${nr.enable ? "1" : "0"}">${nr.enable ? "停用" : "启用"}</button>
      </div>
      ${(nr.channels || []).map((ch) => `
        <div class="ac-notify-channel">
          <span class="ac-notify-method">${escapeHtml(channelLabel(ch.ident))}</span>
          <span class="muted small">${escapeHtml(ch.channelName || "")}</span>
          <span class="ac-notify-address" title="${escapeHtml(ch.address)}">${escapeHtml(ch.address)}</span>
          <button class="small ac-notify-edit" data-nr-id="${escapeHtml(String(nr.ruleId))}" data-nr-name="${escapeHtml(nr.ruleName || "")}" data-ident="${escapeHtml(ch.ident || "")}" data-receivers="${escapeHtml((ch.receivers || []).join(","))}" data-phone="${escapeHtml(ch.phone || "")}" data-email="${escapeHtml(ch.email || "")}">编辑</button>
        </div>
      `).join("")}
    </div>
  `).join("");
}

/** 绑定通知启停 / 编辑操作。 */
function bindNotifyActions(overlay, alert) {
  // 启停（按钮文案是目标动作：当前启用显示"停用"，点击应改为停用）
  overlay.querySelectorAll("[data-nr-enable]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const currentEnabled = btn.dataset.nrEnable === "1";
      const targetEnabled = !currentEnabled;
      btn.disabled = true;
      try {
        await apiPost(`/api/alerts/notify-rules/${btn.dataset.nrId}`, { enable: targetEnabled });
        // 刷新弹窗中的通知区
        const refreshed = await refreshAlertNotify(alert);
        if (refreshed) {
          const list = overlay.querySelector("#ac-alert-notify-list");
          if (list) { list.innerHTML = renderNotifyDetail(refreshed); bindNotifyActions(overlay, { ...alert, notify: refreshed }); }
        }
      } catch (error) {
        btn.disabled = false;
        alert(`操作失败：${error.message}`);
      }
    });
  });
  // 编辑接收人/地址
  overlay.querySelectorAll(".ac-notify-edit").forEach((btn) => {
    btn.addEventListener("click", () => openNotifyEdit(btn, overlay, alert));
  });
}

/** 编辑通知地址（接收人 / 电话 / 邮箱）。 */
function openNotifyEdit(btn, overlay, alert) {
  const channel = btn.closest(".ac-notify-channel");
  const old = channel.innerHTML;
  const ident = btn.dataset.ident || "";
  const isVoice = ident === "ali-voice" || ident === "ivr";
  const isEmail = ident === "email";
  channel.innerHTML = `
    <div class="ac-notify-edit-form">
      <label>接收人（用户名，逗号分隔）
        <input type="text" class="ac-search-input" id="ac-n-rcv" value="${escapeHtml(btn.dataset.receivers || "")}">
      </label>
      ${isVoice ? `
        <label>联系电话
          <input type="text" class="ac-search-input" id="ac-n-phone" value="${escapeHtml(btn.dataset.phone || "")}">
        </label>
      ` : ""}
      ${isEmail ? `
        <label>接收邮箱
          <input type="text" class="ac-search-input" id="ac-n-email" value="${escapeHtml(btn.dataset.email || "")}">
        </label>
      ` : ""}
      <div class="ac-notify-edit-actions">
        <button class="small primary ac-notify-save">保存</button>
        <button class="small ac-notify-cancel">取消</button>
      </div>
    </div>
  `;
  channel.querySelector(".ac-notify-cancel").addEventListener("click", () => { channel.innerHTML = old; });
  channel.querySelector(".ac-notify-save").addEventListener("click", async () => {
    const receivers = (channel.querySelector("#ac-n-rcv")?.value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const params = {};
    if (isVoice) {
      const phone = (channel.querySelector("#ac-n-phone")?.value || "").trim();
      if (phone) params.Mobile = phone;
    }
    if (isEmail) {
      const email = (channel.querySelector("#ac-n-email")?.value || "").trim();
      if (email) params.email = email;
    }
    try {
      // 更新走 PUT 路由（updateNotifyRule 支持 receivers + params），避免被 POST 路由当作 enable 误停用
      const payload = { receivers };
      if (Object.keys(params).length) payload.params = params;
      await apiPut(`/api/alerts/notify-rules/${btn.dataset.nrId}`, payload);
      const refreshed = await refreshAlertNotify(alert);
      if (refreshed) {
        const list = overlay.querySelector("#ac-alert-notify-list");
        if (list) { list.innerHTML = renderNotifyDetail(refreshed); bindNotifyActions(overlay, { ...alert, notify: refreshed }); }
      }
    } catch (error) {
      alert(`保存失败：${error.message}`);
    }
  });
}

/** 重新拉取某告警的通知配置（用于编辑后刷新）。 */
async function refreshAlertNotify(alert) {
  try {
    const active = await apiGet("/api/alerts/active?limit=200");
    const found = (Array.isArray(active) ? active : []).find((a) => String(a.ruleId) === String(alert.ruleId));
    return found?.notify || alert.notify;
  } catch {
    return alert.notify;
  }
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
  acDetailAlerts = alerts.slice(0, 50);
  return `
    <table class="data-table ac-alert-table">
      <thead>
        <tr><th>级别</th><th>规则 / 含义</th><th>国家</th><th>目标</th><th>触发值</th><th>通知</th><th>状态</th></tr>
      </thead>
      <tbody>
        ${acDetailAlerts.map((alert, idx) => `
          <tr class="ac-alert-row" data-alert-idx="${idx}" title="点击查看详情 / 通知配置">
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
            <td class="ac-alert-notify">
              ${renderNotifySummary(alert.notify)}
            </td>
            <td><span class="badge ${alert.isRecovered ? "ok" : "warn"}">${escapeHtml(alert.recoveredLabel || "-")}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderNotifySummary(notify) {
  if (!notify || !notify.length) return `<span class="muted small">未配置</span>`;
  const flat = notify.flatMap((nr) => (nr.channels || []).map((ch) => ({ ruleName: nr.ruleName, enable: nr.enable, ...ch })));
  if (!flat.length) return `<span class="muted small">未配置渠道</span>`;
  return flat.slice(0, 2).map((ch) => `
    <div class="ac-notify-item ${ch.ident ? `is-${ch.ident}` : ""}">
      <span class="ac-notify-method">${escapeHtml(channelLabel(ch.ident))}</span>
      <span class="muted small" title="${escapeHtml(ch.address)}">${escapeHtml(ch.address || "默认")}</span>
      ${ch.enable ? "" : `<span class="badge warn">停用</span>`}
    </div>
  `).join("");
}

function channelLabel(ident) {
  const map = {
    dingtalk: "钉钉",
    "ali-voice": "电话",
    ivr: "电话",
    email: "邮件",
    sms: "短信",
    webhook: "Webhook",
    feishu: "飞书",
    wecom: "企业微信",
  };
  return map[ident] || ident || "通知";
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
// 告警日志 Tab（夜莺历史告警，近 7 天，默认当天）
// ---------------------------------------------------------------------------

const AC_HISTORY_PAGE_SIZE = 20;

async function loadHistoryTab(root, body, refreshTime) {
  if (refreshTime) refreshTime.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
  const groups = await apiGet("/api/alerts/busi-groups").catch(() => []);
  body.innerHTML = renderHistoryTab(groups);
  bindHistoryEvents(root, body);
}

function renderHistoryTab(groups) {
  const groupOptions =
    `<option value="">全部业务组</option>` +
    (groups || []).map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("");
  return `
    <div class="ac-config-grid">
      <section class="sub-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">夜莺告警日志</h2>
            <p class="muted">最近 7 天的告警记录（含已恢复 / 未恢复）。默认显示当天；可按时间范围、业务组、级别、状态、规则名筛选。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <label>时间范围
            <select id="ac-history-range" class="ac-search-input">
              <option value="today" selected>今天</option>
              <option value="7d">近 7 天</option>
            </select>
          </label>
          <label>业务组
            <select id="ac-history-bg" class="ac-search-input">${groupOptions}</select>
          </label>
          <label>级别
            <select id="ac-history-sev" class="ac-search-input">
              <option value="">全部</option>
              <option value="0">严重</option>
              <option value="1">警告</option>
              <option value="2">提示</option>
            </select>
          </label>
          <label>状态
            <select id="ac-history-rec" class="ac-search-input">
              <option value="">全部</option>
              <option value="0">未恢复</option>
              <option value="1">已恢复</option>
            </select>
          </label>
          <input type="text" id="ac-history-search" class="ac-search-input" placeholder="搜索规则名…">
          <button class="primary small" id="ac-history-load">查询</button>
        </div>
        <div id="ac-history-table"></div>
        <div id="ac-history-pager"></div>
      </section>
    </div>
  `;
}

async function bindHistoryEvents(root, body) {
  const loadBtn = body.querySelector("#ac-history-load");
  const tableEl = body.querySelector("#ac-history-table");
  const pagerEl = body.querySelector("#ac-history-pager");
  const rangeSel = body.querySelector("#ac-history-range");
  const bgSel = body.querySelector("#ac-history-bg");
  const sevSel = body.querySelector("#ac-history-sev");
  const recSel = body.querySelector("#ac-history-rec");
  const searchInput = body.querySelector("#ac-history-search");

  let currentPage = 1;
  let drawSeq = 0;   // 防止快速切换筛选时旧响应覆盖新响应
  const draw = async (page) => {
    const seq = ++drawSeq;
    const now = Date.now();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const ranges = {
      today: [Math.floor(dayStart.getTime() / 1000), Math.floor(now / 1000)],
      "7d": [Math.floor((now - 7 * 24 * 3600 * 1000) / 1000), Math.floor(now / 1000)],
    };
    const [stime, etime] = ranges[rangeSel.value] || ranges.today;
    tableEl.innerHTML = `<div class="notice">加载告警日志…</div>`;
    try {
      const query = new URLSearchParams({
        stime: String(stime),
        etime: String(etime),
        group: "true",
      });
      if (bgSel.value) query.set("bgid", bgSel.value);
      if (sevSel.value !== "") query.set("severity", sevSel.value);
      if (recSel.value !== "") query.set("isRecovered", recSel.value);
      const q = (searchInput.value || "").trim();
      if (q) query.set("ruleName", q);
      const data = await apiGet(`/api/alerts/history?${query.toString()}`);
      if (seq !== drawSeq) return;   // 已有更新的请求，丢弃本次结果
      const all = data.list || [];
      const total = all.length;
      const totalPages = Math.ceil(total / AC_HISTORY_PAGE_SIZE) || 1;
      currentPage = Math.min(Math.max(page, 1), totalPages);
      const start = (currentPage - 1) * AC_HISTORY_PAGE_SIZE;
      const pageRows = all.slice(start, start + AC_HISTORY_PAGE_SIZE);
      tableEl.innerHTML = pageRows.length
        ? renderHistoryTable(pageRows)
        : `<p class="muted">无符合条件的告警记录。</p>`;
      bindHistoryExpand(tableEl);
      if (pagerEl) {
        pagerEl.innerHTML = renderAcPager("history", currentPage, totalPages, total, false);
        bindAcPagerEvents(pagerEl, (p) => draw(p));
      }
    } catch (error) {
      if (seq === drawSeq) tableEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
  };

  loadBtn.addEventListener("click", () => draw(1));
  searchInput?.addEventListener("input", () => draw(1));
  searchInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") draw(1); });
  [rangeSel, bgSel, sevSel, recSel].forEach((sel) => sel?.addEventListener("change", () => draw(1)));
  draw(1);
}

function renderHistoryTable(list) {
  return `
    <table class="data-table ac-history-table">
      <thead>
        <tr>
          <th>触发时间</th><th>触发次数</th><th>级别</th><th>业务组</th>
          <th>规则名 / 含义</th><th>状态</th><th>触发值</th><th>国家</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${list.map((a, idx) => `
          <tr class="${a.isRecovered ? "" : "ac-row-unrecovered"}">
            <td class="small mono">${escapeHtml(formatTime(a.triggerTime))}</td>
            <td><span class="badge ac-count-badge">${escapeHtml(String(a.triggerCount ?? 1))} 次</span></td>
            <td><span class="badge ${severityClass(a.severity)}">${escapeHtml(a.severityLabel || "-")}</span></td>
            <td class="small">${escapeHtml(a.groupName || "-")}</td>
            <td class="small">
              <strong>${escapeHtml(a.ruleName || "-")}</strong>
              ${a.meaning ? `<div class="muted ac-his-meaning" title="${escapeHtml(a.meaning)}">${escapeHtml(a.meaning)}</div>` : ""}
            </td>
            <td><span class="badge ${a.isRecovered ? "ok" : "danger"}">${escapeHtml(a.recoveredLabel || "-")}</span></td>
            <td class="num">${escapeHtml(String(a.triggerValue ?? "-"))}</td>
            <td>${a.country ? escapeHtml(a.country) : `<span class="muted">-</span>`}</td>
            <td><button class="small ghost" data-his-expand="${idx}" data-his-label="${a.events?.length > 1 ? `展开 ${a.events.length} 次` : "详情"}">${a.events?.length > 1 ? `展开 ${a.events.length} 次` : "详情"}</button></td>
          </tr>
          ${renderHistoryExpandRow(a, idx)}
        `).join("")}
      </tbody>
    </table>
  `;
}

/** 展开行：列出该告警每次触发的时间 / 状态 / 触发值 / 恢复时间。 */
function renderHistoryExpandRow(a, idx) {
  const events = a.events || [];
  if (!events.length) return "";
  const rows = events.map((e) => `
    <tr>
      <td class="small mono">${escapeHtml(formatTime(e.triggerTime))}</td>
      <td class="small mono" title="${escapeHtml(e.target || "")}">${escapeHtml(e.target || "-")}</td>
      <td><span class="badge ${e.isRecovered ? "ok" : "danger"}">${escapeHtml(e.recoveredLabel || "-")}</span></td>
      <td class="num">${escapeHtml(String(e.triggerValue ?? "-"))}</td>
      <td class="small mono">${e.recoverTime ? escapeHtml(formatTime(e.recoverTime)) : `<span class="muted">-</span>`}</td>
    </tr>
  `).join("");
  return `
    <tr class="ac-his-detail" id="ac-his-detail-${idx}" hidden>
      <td colspan="9">
        <div class="ac-his-detail-inner">
          <strong>该告警每次触发记录（共 ${events.length} 次）</strong>
          <table class="ac-his-events">
            <thead><tr><th>触发时间</th><th>目标</th><th>状态</th><th>触发值</th><th>恢复时间</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </td>
    </tr>
  `;
}

function bindHistoryExpand(tableEl) {
  tableEl.querySelectorAll("[data-his-expand]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const detail = tableEl.querySelector(`#ac-his-detail-${btn.dataset.hisExpand}`);
      if (!detail) return;
      detail.hidden = !detail.hidden;
      btn.textContent = detail.hidden ? (btn.dataset.hisLabel || "展开") : "收起";
    });
  });
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
            <p class="muted">按业务组查看规则，支持编辑规则内容（PromQL / SQL / 级别 / 名称）与启用/停用。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <label>业务组
            <select id="ac-rules-bg" class="ac-search-input">${groupOptions}</select>
          </label>
          <label>状态
            <select id="ac-rules-status" class="ac-search-input">
              <option value="enabled" selected>已启用</option>
              <option value="all">全部</option>
              <option value="disabled">已停用</option>
            </select>
          </label>
          <label class="ac-checkbox-line" title="只显示配置了查询语句（PromQL / SQL）的规则">
            <input type="checkbox" id="ac-rules-hide-empty" checked>
            <span>隐藏无查询语句</span>
          </label>
          <input type="text" id="ac-rules-search" class="ac-search-input" placeholder="搜索规则名…">
          <button class="primary small" id="ac-rules-load">加载规则</button>
        </div>
        <div id="ac-rules-table"></div>
        <div id="ac-rules-pager"></div>
      </section>

      <section class="sub-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">夜莺监控目标</h2>
            <p class="muted">按业务组查看被监控主机：CPU / 内存利用率、在线状态、IP 与标签。支持分页与搜索。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <label>业务组
            <select id="ac-targets-bg" class="ac-search-input">${groupOptions}</select>
          </label>
          <input type="text" id="ac-targets-search" class="ac-search-input" placeholder="搜索标识 / IP / 国家…">
          <button class="primary small" id="ac-targets-load">加载目标</button>
        </div>
        <div id="ac-targets-table"></div>
        <div id="ac-targets-pager"></div>
      </section>

      <section class="sub-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">夜莺数据源</h2>
            <p class="muted">已接入的监控数据源：类型、集群、地址与创建人。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <button class="primary small" id="ac-ds-load">加载数据源</button>
        </div>
        <div id="ac-ds-table"></div>
        <div id="ac-ds-pager"></div>
      </section>

      <section class="sub-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">n8n 工作流</h2>
            <p class="muted">工作流状态与触发地址；可启用/停用激活，点击"详情"查看节点流程。</p>
          </div>
        </div>
        <div class="ac-filter-bar">
          <label>状态
            <select id="ac-wf-filter" class="ac-search-input">
              <option value="true" selected>已激活</option>
              <option value="">全部</option>
              <option value="false">未激活</option>
            </select>
          </label>
          <input type="text" id="ac-wf-search" class="ac-search-input" placeholder="搜索工作流名…">
          <button class="primary small" id="ac-wf-load">加载工作流</button>
        </div>
        <div id="ac-wf-table"></div>
        <div id="ac-wf-pager"></div>
      </section>
    </div>
  `;
}

async function bindConfigEvents(root, body, groups) {
  // ---- 夜莺告警规则 ----
  const rulesLoad = body.querySelector("#ac-rules-load");
  const rulesTable = body.querySelector("#ac-rules-table");
  const rulesPager = body.querySelector("#ac-rules-pager");
  const rulesSearch = body.querySelector("#ac-rules-search");
  const rulesStatus = body.querySelector("#ac-rules-status");
  const rulesHideEmpty = body.querySelector("#ac-rules-hide-empty");
  const bgSelect = body.querySelector("#ac-rules-bg");
  if (rulesLoad && bgSelect) {
    const drawRules = () => {
      const q = (rulesSearch?.value || "").trim();
      const status = rulesStatus?.value || "enabled";
      const hideEmpty = rulesHideEmpty?.checked ?? true;
      const filtered = acRulesCache.filter((r) => {
        if (status === "enabled" && r.disabled) return false;
        if (status === "disabled" && !r.disabled) return false;
        if (hideEmpty && !extractRuleQuery(r)) return false;
        if (q && !String(r.name || "").includes(q)) return false;
        return true;
      });
      const totalPages = Math.ceil(filtered.length / AC_PAGE_SIZE) || 1;
      acPages.rules = Math.min(Math.max(acPages.rules, 1), totalPages);
      rulesTable.innerHTML = renderRulesTable(filtered, acPages.rules);
      bindRulesActions(rulesTable, () => { acPages.rules = 1; drawRules(); });
      if (rulesPager) {
        rulesPager.innerHTML = renderAcPager("rules", acPages.rules, totalPages, filtered.length, !!(q || status !== "all" || hideEmpty));
        bindAcPagerEvents(rulesPager, (page) => { acPages.rules = page; drawRules(); });
      }
    };
    const loadRules = async () => {
      const bg = bgSelect.value;
      if (!bg) { rulesTable.innerHTML = `<p class="muted">请选择业务组。</p>`; return; }
      rulesTable.innerHTML = `<div class="notice">加载规则…</div>`;
      try {
        const rules = await apiGet(`/api/alerts/rules?busiGroup=${bg}`);
        acRulesCache = rules;
        acPages.rules = 1;
        drawRules();
      } catch (error) {
        rulesTable.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    };
    rulesLoad.addEventListener("click", loadRules);
    rulesSearch?.addEventListener("input", () => { acPages.rules = 1; drawRules(); });
    rulesStatus?.addEventListener("change", () => { acPages.rules = 1; drawRules(); });
    rulesHideEmpty?.addEventListener("change", () => { acPages.rules = 1; drawRules(); });
    loadRules();
  }

  // ---- 夜莺监控目标 ----
  const targetsLoad = body.querySelector("#ac-targets-load");
  const targetsTable = body.querySelector("#ac-targets-table");
  const targetsPager = body.querySelector("#ac-targets-pager");
  const targetsSearch = body.querySelector("#ac-targets-search");
  const targetsBg = body.querySelector("#ac-targets-bg");
  if (targetsLoad && targetsBg) {
    const drawTargets = () => {
      const q = (targetsSearch?.value || "").trim().toLowerCase();
      const filtered = acTargetsCache.filter((t) => {
        if (!q) return true;
        return [t.ident, t.host_ip, t.country, (t.tags || []).join(" ")].join(" ").toLowerCase().includes(q);
      });
      const totalPages = Math.ceil(filtered.length / AC_PAGE_SIZE) || 1;
      acPages.targets = Math.min(Math.max(acPages.targets, 1), totalPages);
      targetsTable.innerHTML = renderTargetsTable(filtered, acPages.targets);
      if (targetsPager) {
        targetsPager.innerHTML = renderAcPager("targets", acPages.targets, totalPages, filtered.length, !!q);
        bindAcPagerEvents(targetsPager, (page) => { acPages.targets = page; drawTargets(); });
      }
    };
    const loadTargets = async () => {
      const bg = targetsBg.value;
      if (!bg) { targetsTable.innerHTML = `<p class="muted">请选择业务组。</p>`; return; }
      targetsTable.innerHTML = `<div class="notice">加载目标…</div>`;
      try {
        const list = await apiGet(`/api/alerts/targets?busiGroup=${bg}&limit=500`);
        acTargetsCache = list;
        acPages.targets = 1;
        drawTargets();
      } catch (error) {
        targetsTable.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    };
    targetsLoad.addEventListener("click", loadTargets);
    targetsSearch?.addEventListener("input", () => { acPages.targets = 1; drawTargets(); });
    loadTargets();
  }

  // ---- 夜莺数据源 ----
  const dsLoad = body.querySelector("#ac-ds-load");
  const dsTable = body.querySelector("#ac-ds-table");
  const dsPager = body.querySelector("#ac-ds-pager");
  if (dsLoad) {
    const drawDatasources = () => {
      const totalPages = Math.ceil(acDatasourcesCache.length / AC_PAGE_SIZE) || 1;
      acPages.datasources = Math.min(Math.max(acPages.datasources, 1), totalPages);
      dsTable.innerHTML = renderDatasourcesTable(acDatasourcesCache, acPages.datasources);
      if (dsPager) {
        dsPager.innerHTML = renderAcPager("datasources", acPages.datasources, totalPages, acDatasourcesCache.length, false);
        bindAcPagerEvents(dsPager, (page) => { acPages.datasources = page; drawDatasources(); });
      }
    };
    const loadDatasources = async () => {
      dsTable.innerHTML = `<div class="notice">加载数据源…</div>`;
      try {
        const list = await apiGet("/api/alerts/datasources");
        acDatasourcesCache = list;
        acPages.datasources = 1;
        drawDatasources();
      } catch (error) {
        dsTable.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    };
    dsLoad.addEventListener("click", loadDatasources);
    loadDatasources();
  }

  // ---- n8n 工作流 ----
  const wfLoad = body.querySelector("#ac-wf-load");
  const wfTable = body.querySelector("#ac-wf-table");
  const wfPager = body.querySelector("#ac-wf-pager");
  const wfSearch = body.querySelector("#ac-wf-search");
  const wfFilter = body.querySelector("#ac-wf-filter");
  if (wfLoad) {
    const drawWorkflows = () => {
      const q = (wfSearch?.value || "").trim();
      const filtered = acWorkflowsCache.filter((wf) => {
        if (q && !String(wf.name || "").includes(q)) return false;
        return true;
      });
      const totalPages = Math.ceil(filtered.length / AC_PAGE_SIZE) || 1;
      acPages.workflows = Math.min(Math.max(acPages.workflows, 1), totalPages);
      wfTable.innerHTML = renderWorkflowsTable(filtered, acPages.workflows);
      bindWorkflowActions(wfTable, () => { acPages.workflows = 1; drawWorkflows(); });
      if (wfPager) {
        wfPager.innerHTML = renderAcPager("workflows", acPages.workflows, totalPages, filtered.length, !!q);
        bindAcPagerEvents(wfPager, (page) => { acPages.workflows = page; drawWorkflows(); });
      }
    };
    const loadWorkflows = async () => {
      wfTable.innerHTML = `<div class="notice">加载工作流…</div>`;
      try {
        const active = wfFilter.value === "" ? undefined : wfFilter.value === "true";
        const query = active === undefined ? "?limit=250" : `?active=${active}&limit=250`;
        const list = await apiGet(`/api/alerts/n8n/workflows${query}`);
        acWorkflowsCache = list;
        acPages.workflows = 1;
        drawWorkflows();
      } catch (error) {
        wfTable.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    };
    wfLoad.addEventListener("click", loadWorkflows);
    wfFilter.addEventListener("change", loadWorkflows);
    wfSearch?.addEventListener("input", () => { acPages.workflows = 1; drawWorkflows(); });
    loadWorkflows();
  }
}

/** 绑定规则表操作（启停 / 编辑）。 */
function bindRulesActions(table, reload) {
  table.querySelectorAll("[data-rule-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ruleId = btn.dataset.ruleToggle;
      const disabled = btn.dataset.disabled === "1";
      const rule = acRulesCache.find((r) => String(r.id) === String(ruleId));
      try {
        await apiPost(`/api/alerts/rules/${ruleId}`, { disabled: !disabled ? 1 : 0, groupId: rule?.group_id });
        await reload();
      } catch (error) {
        table.innerHTML += `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    });
  });
  table.querySelectorAll("[data-rule-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rule = acRulesCache.find((r) => String(r.id) === String(btn.dataset.ruleEdit));
      if (rule) openRuleEditModal(rule, reload);
    });
  });
}

/** 绑定工作流表操作（启停 / 详情）。 */
function bindWorkflowActions(table, reload) {
  table.querySelectorAll("[data-wf-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.wfToggle;
      const activeNow = btn.dataset.active === "true";
      btn.disabled = true;
      try {
        await apiPost("/api/alerts/n8n/workflows/toggle", { id, active: !activeNow });
        await reload();
      } catch (error) {
        btn.disabled = false;
        table.innerHTML += `<div class="error">${escapeHtml(error.message)}</div>`;
      }
    });
  });
  table.querySelectorAll("[data-wf-detail]").forEach((btn) => {
    btn.addEventListener("click", () => openWorkflowDetailModal(btn.dataset.wfDetail));
  });
}

function renderRulesTable(rules, page = 1) {
  if (!rules.length) return `<p class="muted">该业务组暂无告警规则。</p>`;
  const start = (page - 1) * AC_PAGE_SIZE;
  const rows = rules.slice(start, start + AC_PAGE_SIZE);
  return `
    <table class="data-table">
      <thead><tr><th>规则名</th><th>查询语句</th><th>级别</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
        ${rows.map((rule) => `
          <tr>
            <td>${escapeHtml(rule.name || "-")}</td>
            <td class="small"><code class="ac-rule-ql">${escapeHtml(extractRuleQuery(rule) || "-")}</code></td>
            <td><span class="badge ${severityClass(rule.severity)}">${escapeHtml(severityLabel(rule.severity))}</span></td>
            <td><span class="badge ${rule.disabled ? "warn" : "ok"}">${rule.disabled ? "已停用" : "启用"}</span></td>
            <td>
              <button class="small" data-rule-edit="${escapeHtml(String(rule.id))}">编辑</button>
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

function renderTargetsTable(list, page = 1) {
  if (!list.length) return `<p class="muted">该业务组暂无监控目标。</p>`;
  const start = (page - 1) * AC_PAGE_SIZE;
  const rows = list.slice(start, start + AC_PAGE_SIZE);
  return `
    <table class="data-table ac-targets-table">
      <thead><tr><th>标识</th><th>IP</th><th>国家</th><th>CPU 利用率</th><th>内存利用率</th><th>OS</th><th>备注</th></tr></thead>
      <tbody>
        ${rows.map((t) => `
          <tr>
            <td class="small">${escapeHtml(t.ident || "-")}</td>
            <td class="small mono">${escapeHtml(t.host_ip || "-")}</td>
            <td>${t.country ? `<span class="badge country">${escapeHtml(countryName(t.country))}</span>` : `<span class="muted">-</span>`}</td>
            <td class="num ${t.cpuUtil > 80 ? "text-danger" : ""}">${t.cpuUtil !== "" ? `${escapeHtml(t.cpuUtil)}%` : "-"}</td>
            <td class="num ${t.memUtil > 80 ? "text-danger" : ""}">${t.memUtil !== "" ? `${escapeHtml(t.memUtil)}%` : "-"}</td>
            <td class="small muted">${escapeHtml([t.os, t.arch].filter(Boolean).join(" / ") || "-")}</td>
            <td class="small muted" title="${escapeHtml(t.note || "")}">${escapeHtml((t.note || "").slice(0, 20) || "-")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderDatasourcesTable(list, page = 1) {
  if (!list.length) return `<p class="muted">暂无数据源。</p>`;
  const start = (page - 1) * AC_PAGE_SIZE;
  const rows = list.slice(start, start + AC_PAGE_SIZE);
  return `
    <table class="data-table">
      <thead><tr><th>名称</th><th>类型</th><th>集群</th><th>地址</th><th>创建人</th><th>状态</th></tr></thead>
      <tbody>
        ${rows.map((ds) => `
          <tr>
            <td>${escapeHtml(ds.name || "-")}</td>
            <td><span class="badge">${escapeHtml(ds.plugin_type || ds.plugin_type_name || "-")}</span></td>
            <td class="small muted">${escapeHtml(ds.cluster_name || "-")}</td>
            <td class="small mono" title="${escapeHtml(ds.url)}">${escapeHtml(ds.url ? ds.url.slice(0, 45) + "…" : "-")}</td>
            <td class="small muted">${escapeHtml(ds.created_by || "-")}</td>
            <td><span class="badge ${String(ds.status) === "enabled" ? "ok" : "warn"}">${ds.status === "enabled" ? "启用" : escapeHtml(String(ds.status || "-"))}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderWorkflowsTable(list, page = 1) {
  if (!list.length) return `<p class="muted">暂无工作流。</p>`;
  const start = (page - 1) * AC_PAGE_SIZE;
  const rows = list.slice(start, start + AC_PAGE_SIZE);
  return `
    <table class="data-table">
      <thead><tr><th>工作流名称</th><th>激活</th><th>触发方式</th><th>节点数</th><th>操作</th></tr></thead>
      <tbody>
        ${rows.map((wf) => `
          <tr>
            <td>${escapeHtml(wf.name || `#${wf.id}`)}</td>
            <td><span class="badge ${wf.active ? "ok" : "warn"}">${wf.active ? "已激活" : "未激活"}</span></td>
            <td class="small">
              ${escapeHtml(wf.triggerType || "无触发")}
              ${wf.webhookUrl ? `<a class="ac-wf-webhook" href="${escapeHtml(wf.webhookUrl)}" target="_blank" rel="noopener" title="${escapeHtml(wf.webhookUrl)}">打开地址 ↗</a>` : ""}
            </td>
            <td class="num">${escapeHtml(String(wf.nodeCount ?? "-"))}</td>
            <td>
              <button class="small" data-wf-detail="${escapeHtml(String(wf.id))}">详情</button>
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

/** 国家代码 -> 中文（展示用）。 */
function countryName(code) {
  const map = { cn: "中国", ina: "印尼", mx: "墨西哥", mex: "墨西哥", phl: "菲律宾", ph: "菲律宾", pak: "巴基斯坦", pk: "巴基斯坦", tha: "泰国", th: "泰国", hongkong: "香港", hk: "香港", china: "中国" };
  return map[String(code).toLowerCase()] || code;
}

function extractRuleQuery(rule) {
  const queries = rule.rule_config?.queries || [];
  for (const q of queries) {
    if (q?.sql) return q.sql;
    if (q?.prom_ql) return q.prom_ql;
  }
  // 夜莺 PromQL 也存顶层 prom_ql 字段（部分规则无 rule_config.queries）
  return rule.prom_ql || "";
}

/** 打开告警规则编辑弹窗。 */
function openRuleEditModal(rule, reload) {
  const query = extractRuleQuery(rule);
  const isSql = Boolean(rule.cate === "mysql" || rule.rule_config?.queries?.[0]?.sql);
  const queries = rule.rule_config?.queries || [];

  const overlay = document.createElement("div");
  overlay.id = "ac-rule-modal";
  overlay.className = "ac-modal-overlay";
  overlay.innerHTML = `
    <div class="ac-modal ac-rule-modal" role="dialog" aria-modal="true" aria-label="编辑告警规则">
      <div class="ac-modal-head">
        <strong>编辑告警规则</strong>
        <button class="ac-modal-close" aria-label="关闭">✕</button>
      </div>
      <div class="ac-modal-body">
        <div class="ac-rule-form">
          <label>规则名称
            <input type="text" class="ac-search-input" id="ac-rule-name" value="${escapeHtml(rule.name || "")}">
          </label>
          <label>级别
            <select class="ac-search-input" id="ac-rule-severity">
              <option value="0" ${Number(rule.severity) === 0 ? "selected" : ""}>严重 (0)</option>
              <option value="1" ${Number(rule.severity) === 1 ? "selected" : ""}>警告 (1)</option>
              <option value="2" ${Number(rule.severity) === 2 ? "selected" : ""}>提示 (2)</option>
            </select>
          </label>
          <label>${isSql ? "SQL 查询" : "PromQL 查询"}
            <textarea class="ac-search-input ac-rule-query" id="ac-rule-query" rows="6">${escapeHtml(query)}</textarea>
          </label>
          <label class="ac-rule-toggle-line">
            <input type="checkbox" id="ac-rule-disabled" ${rule.disabled ? "checked" : ""}>
            <span>停用此规则</span>
          </label>
          <div class="ac-rule-form-actions">
            <button class="primary small" id="ac-rule-save">保存</button>
            <button class="small ac-rule-cancel">取消</button>
          </div>
          <p class="muted small">保存后规则即时生效。评估周期 ${escapeHtml(String(rule.prom_eval_interval || "-"))} 秒。</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.classList.add("show");
  const close = () => { overlay.classList.remove("show"); setTimeout(() => overlay.remove(), 180); };
  overlay.querySelector(".ac-modal-close").addEventListener("click", close);
  overlay.querySelector(".ac-rule-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  document.addEventListener("keydown", function onEsc(event) {
    if (event.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  overlay.querySelector("#ac-rule-save").addEventListener("click", async () => {
    const saveBtn = overlay.querySelector("#ac-rule-save");
    saveBtn.disabled = true;
    const name = overlay.querySelector("#ac-rule-name").value.trim();
    const severity = Number(overlay.querySelector("#ac-rule-severity").value);
    const newQuery = overlay.querySelector("#ac-rule-query").value.trim();
    const disabled = overlay.querySelector("#ac-rule-disabled").checked ? 1 : 0;
    try {
      const body = { name, severity, disabled, groupId: rule.group_id };
      // 查询字段：写 rule_config.queries[0]（保留现有 queries 结构），PromQL 规则同时写顶层 prom_ql
      const firstQuery = queries.length ? { ...queries[0] } : (isSql ? { sql: newQuery, severity } : { prom_ql: newQuery, severity, unit: "none" });
      if (isSql) firstQuery.sql = newQuery; else firstQuery.prom_ql = newQuery;
      body.rule_config = {
        ...(rule.rule_config || {}),
        queries: queries.length
          ? queries.map((q, i) => i === 0 ? { ...q, ...(isSql ? { sql: newQuery } : { prom_ql: newQuery }) } : q)
          : [firstQuery],
      };
      if (!isSql) body.prom_ql = newQuery;
      await apiPut(`/api/alerts/rules/${rule.id}`, body);
      close();
      await reload();
    } catch (error) {
      saveBtn.disabled = false;
      alert(`保存失败：${error.message}`);
    }
  });
}

/** 打开 n8n 工作流详情弹窗。 */
async function openWorkflowDetailModal(id) {
  const existing = document.getElementById("ac-wf-modal");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "ac-wf-modal";
  overlay.className = "ac-modal-overlay";
  overlay.innerHTML = `
    <div class="ac-modal ac-wf-modal" role="dialog" aria-modal="true" aria-label="工作流详情">
      <div class="ac-modal-head">
        <strong>工作流详情</strong>
        <button class="ac-modal-close" aria-label="关闭">✕</button>
      </div>
      <div class="ac-modal-body"><div class="notice">加载工作流…</div></div>
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
    const wf = await apiGet(`/api/alerts/n8n/workflows/detail?id=${encodeURIComponent(id)}`);
    bodyEl.innerHTML = `
      <div class="ac-exec-detail-head">
        <div>
          <strong>${escapeHtml(wf.name || `#${wf.id}`)}</strong>
          <span class="muted"> 更新于 ${escapeHtml(formatIso(wf.updatedAt))}</span>
        </div>
        <span class="badge ${wf.active ? "ok" : "warn"}">${wf.active ? "已激活" : "未激活"}</span>
      </div>
      ${wf.description ? `<p class="muted small">${escapeHtml(wf.description)}</p>` : ""}
      <div class="ac-alert-detail-block">
        <h4>节点 (${(wf.nodes || []).length})</h4>
        <div class="ac-wf-nodes">
          ${(wf.nodes || []).map((n) => `
            <div class="ac-wf-node">
              <strong>${escapeHtml(n.name)}</strong>
              <span class="muted small">${escapeHtml(nodeTypeLabel(n.type))}</span>
            </div>
          `).join("") || `<p class="muted">无节点</p>`}
        </div>
      </div>
      ${(wf.connections || []).length ? `
        <div class="ac-alert-detail-block">
          <h4>流程连接</h4>
          <div class="ac-wf-connections">
            ${wf.connections.map((c) => `<span class="ac-wf-conn">${escapeHtml(c)}</span>`).join("")}
          </div>
        </div>
      ` : ""}
    `;
  } catch (error) {
    bodyEl.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function nodeTypeLabel(type) {
  if (!type) return "";
  const parts = String(type).split(".");
  return parts[parts.length - 1] || type;
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
  const map = { 0: "critical", 1: "warn", 2: "ok", 3: "critical" };
  return map[severity] || "";
}

function severityLabel(severity) {
  return { 0: "严重", 1: "警告", 2: "提示", 3: "紧急" }[severity] ?? String(severity ?? "-");
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

// ===========================================================================
// UI 原型变体（prototype skill 子形状A：同一路由 ?variant= 切换）
// 三种结构性不同的布局，供用户在浏览器挑选。选定后折叠赢家进正式版，删除其余。
// ===========================================================================

/** 变体 A：分栏工作台 —— 紧凑 hero + 左组列表右明细，消灭纵向堆叠。 */
function renderVariantA(stats, groups, overview, activeList) {
  const firstGroup = groups[0]?.[1] || [];
  return `
    <div class="va-hero">
      <div class="va-hero-item ${stats.activeCount ? "is-hot" : ""}">
        <span>活跃告警</span><strong>${escapeHtml(stats.activeCount)}</strong>
      </div>
      <div class="va-hero-item ${stats.severity0 ? "is-critical" : ""}">
        <span>严重</span><strong>${escapeHtml(stats.severity0)}</strong>
      </div>
      <div class="va-hero-item ${stats.failedCount ? "is-warn" : ""}">
        <span>n8n 失败</span><strong>${escapeHtml(stats.failedCount)}</strong>
      </div>
      <div class="va-hero-meta">
        <span>${escapeHtml(stats.groupCount)} 组 · 更新 ${escapeHtml(formatTimeShort(stats.checkedAt))}</span>
      </div>
    </div>
    <div class="va-split">
      <aside class="va-side">
        <div class="va-side-head">业务组</div>
        <div class="va-group-list">
          ${groups.map(([name, alerts]) => {
            const sev0 = alerts.filter((a) => Number(a.severity) === 0).length;
            return `
              <button type="button" class="va-group-item ${sev0 ? "has-critical" : ""}" data-ac-group="${escapeHtml(name)}">
                <span class="va-group-dot ${sev0 ? "is-critical" : ""}"></span>
                <span class="va-group-name">${escapeHtml(name)}</span>
                <span class="va-group-n">${alerts.length}</span>
              </button>
            `;
          }).join("") || `<div class="muted">暂无告警组</div>`}
        </div>
      </aside>
      <main class="va-main">
        <div class="va-main-head">
          <h2 class="panel-title">告警明细</h2>
          <span class="muted">点击左侧业务组切换</span>
        </div>
        <div id="ac-group-detail">${renderGroupDetailRows(firstGroup)}</div>
      </main>
    </div>
    ${renderN8nFailuresPanel(overview.n8n || {}, stats.failedCount || 0)}
  `;
}

/** 变体 B：卡片仪表盘 —— 无 hero 表格，全部卡片网格，点击下钻。 */
function renderVariantB(stats, groups, overview, activeList) {
  const sevSum = (alerts, sev) => alerts.filter((a) => Number(a.severity) === sev).length;
  return `
    <div class="vb-statbar">
      <div class="vb-stat ${stats.severity0 ? "is-critical" : ""}">
        <strong>${escapeHtml(stats.severity0)}</strong><span>严重</span>
      </div>
      <div class="vb-stat">
        <strong>${escapeHtml(stats.severity1)}</strong><span>警告</span>
      </div>
      <div class="vb-stat">
        <strong>${escapeHtml(stats.severity2)}</strong><span>提示</span>
      </div>
      <div class="vb-stat ${stats.failedCount ? "is-warn" : ""}">
        <strong>${escapeHtml(stats.failedCount)}</strong><span>n8n 失败</span>
      </div>
      <div class="vb-stat">
        <strong>${escapeHtml(stats.activeCount)}</strong><span>活跃总数</span>
      </div>
    </div>
    <div class="vb-cards">
      ${groups.map(([name, alerts]) => {
        const sev0 = sevSum(alerts, 0), sev1 = sevSum(alerts, 1), sev2 = sevSum(alerts, 2);
        return `
          <button type="button" class="vb-card ${sev0 ? "has-critical" : ""}" data-ac-group="${escapeHtml(name)}">
            <div class="vb-card-head">
              <strong>${escapeHtml(name)}</strong>
              <span class="vb-card-total">${alerts.length}</span>
            </div>
            <div class="vb-card-sev">
              ${sev0 ? `<span class="vb-sev critical">${sev0} 严重</span>` : ""}
              ${sev1 ? `<span class="vb-sev warn">${sev1} 警告</span>` : ""}
              ${sev2 ? `<span class="vb-sev ok">${sev2} 提示</span>` : ""}
              ${!sev0 && !sev1 && !sev2 ? `<span class="vb-sev none">暂无级别</span>` : ""}
            </div>
            <div class="vb-card-preview">${escapeHtml(alerts.slice(0, 2).map((a) => a.ruleName || "告警").join("，") || "暂无明细")}</div>
          </button>
        `;
      }).join("") || `<div class="muted">暂无告警组</div>`}
    </div>
    <div id="ac-group-detail">${renderGroupDetailRows(groups[0]?.[1] || [])}</div>
  `;
}

/** 变体 C：极简聚焦 —— 一行 hero + 合并所有告警的紧凑表。 */
function renderVariantC(stats, groups, overview, activeList, config) {
  const all = (activeList || []).slice().sort((a, b) => {
    const sa = Number(a.severity), sb = Number(b.severity);
    if (sa !== sb) return (sa || 9) - (sb || 9);
    return String(a.ruleName || "").localeCompare(String(b.ruleName || ""));
  }).slice(0, 100);
  acDetailAlerts = all;
  const sevRow = (s, label) => `<span class="vc-sev ${severityClass(s)}">${label} ${escapeHtml(all.filter((a) => Number(a.severity) === s).length)}</span>`;
  return `
    <div class="vc-top">
      <div class="vc-title">
        <h2 class="panel-title">当前活跃告警</h2>
        <span class="muted">共 ${escapeHtml(all.length)} 条 · 更新 ${escapeHtml(formatTimeShort(stats.checkedAt))}</span>
      </div>
      <div class="vc-sevs">
        ${sevRow(0, "严重")}${sevRow(1, "警告")}${sevRow(2, "提示")}
        <span class="vc-sev warn">n8n失败 ${escapeHtml(stats.failedCount)}</span>
      </div>
    </div>
    <table class="data-table ac-alert-table vc-table">
      <thead>
        <tr><th>级别</th><th>规则</th><th>国家</th><th>目标</th><th>触发值</th></tr>
      </thead>
      <tbody>
        ${all.map((alert, idx) => `
          <tr class="ac-alert-row" data-alert-idx="${idx}" title="点击查看详情">
            <td><span class="badge ${severityClass(alert.severity)}">${escapeHtml(alert.severityLabel || "-")}</span></td>
            <td>
              <strong>${escapeHtml(alert.ruleName || "-")}</strong>
              ${alert.meaning ? `<div class="ac-alert-meaning">${escapeHtml(alert.meaning)}</div>` : ""}
            </td>
            <td>${alert.country && alert.country !== "未知" ? `<span class="badge country">${escapeHtml(alert.country)}</span>` : `<span class="muted">-</span>`}</td>
            <td class="small">${escapeHtml(alert.target || "-")}</td>
            <td class="num">${escapeHtml(alert.triggerValue ?? "-")}</td>
          </tr>
        `).join("") || `<tr><td colspan="5"><p class="muted">当前无活跃告警。</p></td></tr>`}
      </tbody>
    </table>
  `;
}

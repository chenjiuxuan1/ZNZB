import { apiDelete, apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const SOURCE_LABELS = { "codex-skill": "Codex Skill", n8n: "n8n", "duty-platform": "值班平台" };
const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
let model = { report: null, config: null, status: null, loading: false, days: 30, globalRange: null, access: null, accessStatus: null };

function countryLabel(code) {
  return COUNTRY_LABELS[code] || code || "-";
}

const ACTION_LABELS = {
  resolve_project: "解析项目",
  list_alert_groups: "告警组列表",
  list_projects: "项目列表",
  list_workflows: "工作流列表",
  create_workflow: "创建工作流",
  list_schedules: "调度列表",
  get_schedule: "获取调度",
  create_schedule: "创建调度",
  update_schedule: "更新调度",
  batch_update_schedule_alerts: "批量更新调度告警",
  online_schedule: "上线调度",
  offline_schedule: "下线调度",
  schedule_blast_radius: "调度影响范围",
  get_workflow: "获取工作流",
  online_workflow: "上线工作流",
  offline_workflow: "下线工作流",
  trigger_workflow: "触发工作流",
  list_instances: "实例列表",
  get_instance: "获取实例",
  list_task_instances: "任务实例列表",
  get_task_log: "任务日志",
  retry_instance: "重试实例",
  stop_instance: "停止实例",
  force_fail_instance: "强制失败实例",
  check_failed_instances: "检查失败实例",
  list_datasources: "数据源列表",
  get_datasource: "获取数据源",
  extract_task_runtime_config: "提取任务运行配置",
  list_resources: "资源列表",
  view_resource_file: "查看资源文件",
  search_resource_sql: "搜索资源SQL",
  find_resource_usage: "资源使用查询",
  search_country_git_sql: "搜索国家Git SQL",
  append_task: "追加任务",
  append_sql_task: "追加SQL任务",
  append_shell_task: "追加Shell任务",
  update_task: "更新任务",
  update_sql_task: "更新SQL任务",
  update_shell_task: "更新Shell任务",
  disable_tasks_except: "禁用指定之外任务",
  disable_task: "禁用任务",
  delete_task: "删除任务",
  dump_workflow_graph: "导出工作流图",
};

function actionLabel(key) {
  return ACTION_LABELS[key] || key || "-";
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || "-";
}

export function fmtDuration(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function sourceBadge(report) {
  const map = {
    snapshot: { cls: "ok", text: "缓存快照" },
    ssh: { cls: "ok", text: "SSH 审计库" },
    gateway: { cls: "warn", text: "n8n 网关" },
    empty: { cls: "", text: "暂无数据" },
  };
  const item = map[report?.source] || { cls: "", text: report?.source || "-" };
  return `<span class="badge ${item.cls}">${item.text}</span>`;
}

let activeRoot = null;

export function renderDsSchedulerUsage(root) {
  activeRoot = root;
  paint(root);
  loadConfigOnly(root);
  loadAccess(root);
}

async function loadConfigOnly(root) {
  try {
    model.config = await apiGet("/api/ds-scheduler/config", { timeoutMs: 30000 });
  } catch {
    model.config = null;
  }
  paint(root);
}

async function load(root) {
  model.loading = true;
  model.status = null;
  try {
    model.report = await apiGet(`/api/ds-scheduler/usage?days=${model.days}`, { timeoutMs: 90000 });
  } catch (error) {
    model.report = null;
    model.status = { type: "error", text: `加载失败：${error.message}` };
  }
  try {
    model.config = await apiGet("/api/ds-scheduler/config", { timeoutMs: 30000 });
  } catch {
    model.config = null;
  }
  model.loading = false;
  paint(root);
}

async function refresh(root) {
  const btn = root.querySelector("#dsu-refresh");
  if (!btn || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.innerHTML = `<span class="btn-spinner"></span>刷新中…`;
  try {
    model.report = await apiPost("/api/ds-scheduler/usage/refresh", { days: model.days }, { timeoutMs: 120000 });
    if (model.report?.error) {
      model.status = { type: "error", text: `刷新失败：${model.report.refreshError || "数据源不可达"}` };
    } else if (model.report?.enabled === false) {
      model.status = { type: "warn", text: "功能未启用：请将 config/ds-scheduler.config.json 中 usage.enabled 设为 true。" };
    } else {
      model.status = { type: "ok", text: "已从数据源刷新最新使用情况。" };
    }
  } catch (error) {
    model.status = { type: "error", text: `刷新失败：${error.message}` };
  } finally {
    btn.dataset.busy = "0";
  }
  const target = activeRoot || root;
  paint(target);
}

function paint(root) {
  activeRoot = root;
  const report = model.report;
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">DS网关使用统计</h1>
        <p class="page-note">统计 n8n <code>ds-scheduler-router</code> 网关的审计记录：按国家分开展示每天谁在使用、调用了哪些动作、成功率与风险操作等，可对每个国家单独设置统计时间范围。${report ? sourceBadge(report) : ""}</p>
      </div>
      ${renderHeroStats(report)}
    </div>
    ${renderStatus(report)}
    ${renderTokens()}
    ${renderMain(report)}
    ${renderAccess(root)}
  `;
  root.querySelector("#dsu-refresh")?.addEventListener("click", () => refresh(root));
  root.querySelectorAll("[data-role='global-from'], [data-role='global-to']").forEach((input) => {
    input.addEventListener("change", () => {
      const fromEl = root.querySelector("[data-role='global-from']");
      const toEl = root.querySelector("[data-role='global-to']");
      model.globalRange = { from: fromEl ? fromEl.value : "", to: toEl ? toEl.value : "" };
      paint(root);
    });
  });
  root.querySelectorAll("[data-token-action='copy']").forEach((btn) => {
    btn.addEventListener("click", () => copyToken(btn));
  });
  bindAccessEvents(root);
}

function renderHeroStats(report) {
  return `
    <div class="hero-stats" aria-label="网关使用统计概览">
      <article><span>统计天数</span><strong>${report?.dayCount ?? "—"}</strong></article>
      <article><span>调用总次数</span><strong>${report?.totalRequests ?? "—"}</strong></article>
      <article><span>使用人数</span><strong>${report?.uniqueOperators ?? "—"}</strong></article>
      <article><span>成功率</span><strong>${report ? `${report.totalSuccessRate ?? 0}%` : "—"}</strong></article>
      <article><span>风险操作</span><strong>${report?.totalRiskActions ?? "—"}</strong></article>
    </div>
  `;
}

function renderTokens() {
  const countries = (model.config && model.config.countries) || {};
  const rows = COUNTRY_ORDER.map((code) => {
    const token = (countries[code] && countries[code].token) || "";
    const label = countryLabel(code);
    return `
      <div class="dsu-token-row" data-country="${code}">
        <span class="dsu-token-country">${escapeHtml(label)}</span>
        <code class="dsu-token-value">${escapeHtml(token || "未配置")}</code>
        ${token ? `<button class="secondary small" data-token-action="copy" data-country="${code}">复制</button>` : ""}
      </div>`;
  }).join("");
  const configured = COUNTRY_ORDER.filter((code) => (countries[code] && countries[code].token)).length;
  return `
    <details class="panel dsu-token-details">
      <summary>国家 Token（API 调用用）· 已配置 ${configured}/${COUNTRY_ORDER.length}</summary>
      <div class="dsu-token-grid">
        ${rows}
      </div>
    </details>
  `;
}

function tokenOf(country) {
  return ((model.config && model.config.countries && model.config.countries[country]) || {}).token || "";
}

function copyToken(btn) {
  const row = btn.closest("[data-country]");
  const country = row.getAttribute("data-country");
  const value = tokenOf(country);
  if (!value) return;
  const done = () => {
    const prev = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = prev; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
  } else {
    fallbackCopy(value, done);
  }
}

function fallbackCopy(value, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) {
    // ignore
  }
}

function renderStatus(report) {
  if (report?.error || model.status?.type === "error") {
    const reason = report?.refreshError || model.status?.text || "数据源不可达";
    return `<div class="sandbox-status error"><strong>暂时无法获取数据</strong><span>${escapeHtml(reason)}</span></div>`;
  }
  if (model.status?.type === "warn") {
    return `<div class="sandbox-status warn"><strong>${escapeHtml(model.status.text)}</strong></div>`;
  }
  if (model.status?.type === "ok") {
    return `<div class="sandbox-status success"><strong>${escapeHtml(model.status.text)}</strong></div>`;
  }
  return "";
}

function renderDailyOverview(report) {
  const countries = (report && report.countryUsage) || [];
  if (!countries.length) return "";
  const range = model.globalRange || {};
  const byCountry = new Map();
  for (const c of countries) {
    for (const d of countryWindow(c, range)) {
      if (!d.date) continue;
      let umap = byCountry.get(c.country);
      if (!umap) { umap = new Map(); byCountry.set(c.country, umap); }
      for (const op of (d.operators || [])) {
        const name = op.user || "未知";
        umap.set(name, (umap.get(name) || 0) + op.requests);
      }
    }
  }
  if (!byCountry.size) return "";
  const rows = [...byCountry.entries()]
    .sort((a, b) => { const sa=[...a[1].values()].reduce((x,y)=>x+y,0); const sb=[...b[1].values()].reduce((x,y)=>x+y,0); return sb-sa; })
    .map(([country, umap]) => {
      const users = [...umap.entries()].map(([name, req]) => `${escapeHtml(name)}×${req}`).join("、");
      return `<tr>
        <td><b>${escapeHtml(countryLabel(country))}</b></td>
        <td class="dsu-daily-users">${users || "—"}</td>
      </tr>`;
    }).join("");
  return `
    <section class="panel dsu-daily-overview">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">国家使用概览</h2>
          <p class="muted">按国家合并（使用人 × 次数）</p>
        </div>
      </div>
      <div class="dsu-daily-body">
        <table class="ds-table">
          <thead><tr><th>国家</th><th>使用人（次数）</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderMain(report) {
  if (!model.globalRange) model.globalRange = globalDefaultRange(report);
  const range = model.globalRange;
  return `
    ${renderDailyOverview(report)}
    <section class="panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">国家使用分布</h2>
          <p class="muted">${report?.generatedAt ? `最近更新：${new Date(report.generatedAt).toLocaleString("zh-CN")}` : ""} · 全局时间筛选应用于所有国家</p>
        </div>
        <div class="button-group"><button class="primary" id="dsu-refresh">刷新数据</button></div>
      </div>
      <div class="dsu-country-toolbar dsu-global-toolbar">
        <span class="dsu-filter-label">时间筛选</span>
        <label>开始<input type="date" class="input" data-role="global-from" value="${escapeHtml(range.from)}"></label>
        <label>结束<input type="date" class="input" data-role="global-to" value="${escapeHtml(range.to)}"></label>
        <span class="muted">对所有国家生效</span>
      </div>
      ${renderCountryList(report)}
    </section>
  `;
}

function renderCountryList(report) {
  if (report?.error) {
    return renderEmptyHint("数据源不可达", report?.refreshError || "");
  }
  if (report?.enabled === false) {
    return renderEmptyHint("未启用");
  }
  const countries = (report && report.countryUsage) || [];
  if (!countries.length) {
    return renderEmptyHint("暂无数据");
  }
  return `
    <div class="dsu-country-list">
      ${countries.map((c) => renderCountry(c)).join("")}
    </div>
  `;
}

function dsDateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function globalDefaultRange(report) {
  return { from: dsDateStr(-1), to: dsDateStr(0) };
}

function countryDefaultRange(c) {
  const dates = (c.daily || []).map((d) => d.date).filter(Boolean);
  if (!dates.length) return { from: "", to: "" };
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

function countryWindow(c, range) {
  const from = (range && range.from) || "";
  const to = (range && range.to) || "";
  return (c.daily || []).filter((d) => (!from || d.date >= from) && (!to || d.date <= to));
}

function aggregateCountry(c, range) {
  const daily = countryWindow(c, range);
  let requests = 0, success = 0, failed = 0, riskActions = 0, noToken = 0;
  const operators = new Map();
  const actions = new Map();
  const tokens = new Set();
  for (const d of daily) {
    requests += d.requests;
    success += d.success;
    failed += d.failed;
    riskActions += d.riskActions;
    noToken += (d.noToken || 0);
    for (const op of (d.operators || [])) {
      const agg = operators.get(op.token) || { token: op.token, user: op.user || "", requests: 0, success: 0, failed: 0, riskActions: 0, durationTotalMs: 0, actions: new Map(), tools: new Set() };
      agg.requests += op.requests;
      agg.success += op.success;
      agg.failed += op.failed;
      agg.riskActions += op.riskActions;
      agg.durationTotalMs += (op.avgDurationMs || 0) * op.requests;
      for (const [a, n] of Object.entries(op.actions || {})) agg.actions.set(a, (agg.actions.get(a) || 0) + n);
      for (const t of (op.tools || [])) agg.tools.add(t);
      operators.set(op.token, agg);
    }
    for (const [a, n] of Object.entries(d.actions || {})) actions.set(a, (actions.get(a) || 0) + n);
    for (const t of (d.tokens || [])) tokens.add(t);
  }
  const opList = [...operators.values()].map((op) => ({
    token: op.token,
    user: op.user || "",
    requests: op.requests,
    success: op.success,
    failed: op.failed,
    successRate: op.requests ? Math.round((op.success / op.requests) * 1000) / 10 : 0,
    riskActions: op.riskActions,
    avgDurationMs: op.requests ? Math.round(op.durationTotalMs / op.requests) : 0,
    actions: Object.fromEntries([...op.actions.entries()].sort((a, b) => b[1] - a[1])),
    tools: [...op.tools].sort(),
  })).sort((a, b) => b.requests - a.requests);
  return {
    country: c.country,
    requests,
    success,
    failed,
    successRate: requests ? Math.round((success / requests) * 1000) / 10 : 0,
    riskActions,
    noToken,
    uniqueOperators: opList.length,
    operators: opList,
    tokens: [...tokens].sort(),
    actions: Object.fromEntries([...actions.entries()].sort((a, b) => b[1] - a[1])),
    daily,
  };
}

function renderCountry(c) {
  const range = model.globalRange || countryDefaultRange(c);
  const data = aggregateCountry(c, range);
  const hasData = data.requests > 0;
  return `
    <details class="dsu-country" ${hasData ? "open" : ""}>
      <summary>
        <span class="dsu-country-name">${escapeHtml(countryLabel(c.country))}</span>
        <span class="dsu-day-meta">
          <span class="chip">${data.requests} 次</span>
          <span class="chip">${data.uniqueOperators} 人</span>
          <span class="chip ${rateClass(data.successRate)}">成功率 ${data.successRate}%</span>
          ${data.riskActions ? `<span class="chip chip-danger">风险 ${data.riskActions}</span>` : ""}
        </span>
      </summary>
      <div class="dsu-country-body">
        <div class="dsu-country-toolbar">
          <span class="dsu-filter-label">时间范围</span>
          <span class="muted">覆盖 ${data.daily.length} 天${data.daily.length ? `（${data.daily[0].date} ~ ${data.daily[data.daily.length - 1].date}）` : ""}</span>
        </div>
        ${data.noToken ? `<div class="dsu-no-token">未携带 Token 调用 ${data.noToken} 次（无法归属到用户）</div>` : ""}
        <div class="dsu-row">
          <div class="dsu-kpi">
            ${kpi("成功 / 失败", `${data.success} / ${data.failed}`)}
            ${kpi("风险操作", data.riskActions)}
            ${kpi("统计天数", data.daily.length)}
          </div>
        </div>
        ${data.tokens && data.tokens.length ? `
        <div class="dsu-tokens-row">
          <span class="dsu-filter-label">使用 Token</span>
          <span class="dsu-token-tags">${data.tokens.map((t) => `<code class="dsu-token-tag">${escapeHtml(t)}</code>`).join("")}</span>
        </div>` : ""}
        ${renderBreakdown("动作分布", data.actions, (key) => actionLabel(key))}
        <div class="dsu-table-wrap">
          <table class="ds-table dsu-operator-table">
            <thead>
              <tr><th>Token（用户名）</th><th>调用次数</th><th>成功/失败</th><th>成功率</th><th>风险操作</th><th>平均耗时</th><th>主要动作</th></tr>
            </thead>
            <tbody>
              ${data.operators.filter((op) => op.token && op.token !== "-").map((op) => renderCountryOperatorRow(op)).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  `;
}

function renderEmptyHint(kind, extra = "") {
  if (kind === "未启用") {
    return `
      <div class="notice">
        <strong>功能未启用</strong>
        <span>当前 <code>config/ds-scheduler.config.json</code> 里 <code>usage.enabled</code> 不是 true，平台没有调用 n8n 网关。请把 <code>usage.enabled</code> 设为 <code>true</code> 后重启平台。</span>
      </div>
    `;
  }
  if (kind === "数据源不可达") {
    return `
      <div class="notice">
        <strong>数据源不可达</strong>
        <span>${extra ? `${escapeHtml(extra)}<br>` : ""}当前取数方式为 gateway（n8n 网关）。请确认：① n8n 已导入并激活 <code>n8n-ds-usage-report.json</code>；② 平台能访问 <code>DS_USAGE_WEBHOOK_URL</code> 指向的 n8n；③ 平台已配置 <code>DS_AUDIT_DB_PASSWORD</code> 并经 webhook 下发。也可改用 <code>ssh</code> 直连跳板机，或导入本地快照后查看缓存。</span>
      </div>
    `;
  }
  return `
    <div class="notice">
      <strong>暂无数据</strong>
      <span>当前统计周期内没有审计记录。若 n8n 已收到请求并返回 0 条，说明审计表 <code>ds_operation_audit_log</code> 在窗口内没有数据；否则请查看服务端日志确认是否已调用网关。</span>
    </div>
  `;
}

function rateClass(rate) {
  const value = Number(rate) || 0;
  if (value >= 90) return "chip-ok";
  if (value >= 60) return "chip-warn";
  return "chip-danger";
}

function kpi(label, value) {
  return `<div class="dsu-kpi-item"><div class="dsu-kpi-value">${escapeHtml(String(value))}</div><div class="dsu-kpi-label">${escapeHtml(label)}</div></div>`;
}

function renderBreakdown(title, map, labelFn) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return "";
  return `
    <div class="dsu-breakdown">
      <div class="dsu-breakdown-title">${escapeHtml(title)}</div>
      <div class="dsu-breakdown-bars">
        ${entries.map(([key, count]) => `
          <div class="dsu-bar">
            <span class="dsu-bar-label">${escapeHtml(labelFn(key))}</span>
            <span class="dsu-bar-track"><span class="dsu-bar-fill" style="width:${Math.max(4, Math.round((count / entries[0][1]) * 100))}%"></span></span>
            <span class="dsu-bar-count">${count}</span>
          </div>`).join("")}
      </div>
    </div>
  `;
}

function renderCountryOperatorRow(op) {
  const hasToken = Boolean(op.token && op.token !== "-");
  const user = (op.user || "").trim();
  const tokenLabel = hasToken ? op.token : "未使用Token";
  const nameTag = hasToken ? (user ? `（${escapeHtml(user)}）` : "（未知）") : "";
  return `
    <tr>
      <td><code class="dsu-token-tag">${escapeHtml(tokenLabel)}</code>${nameTag}</td>
      <td>${op.requests}</td>
      <td>${op.success} / ${op.failed}</td>
      <td><span class="chip ${rateClass(op.successRate)}">${op.successRate}%</span></td>
      <td>${op.riskActions}</td>
      <td>${fmtDuration(op.avgDurationMs)}</td>
      <td class="muted">${Object.entries(op.actions || {}).slice(0, 3).map(([a, n]) => `${escapeHtml(actionLabel(a))}×${n}`).join(" · ") || "-"}</td>
    </tr>
  `;
}

// ---------------------------------------------------------------------------
// 用户权限与管控（DS 网关）
// ---------------------------------------------------------------------------

const ROLE_BADGE = {
  admin: { cls: "chip-ok", label: "管理员" },
  power: { cls: "chip-warn", label: "高级" },
  operator: { cls: "chip", label: "运维" },
  readonly: { cls: "chip", label: "只读" },
};

async function loadAccess(root) {
  try {
    model.access = await apiGet("/api/ds-scheduler/access", { timeoutMs: 40000 });
    model.accessStatus = null;
  } catch (error) {
    model.access = null;
    model.accessStatus = { type: "error", text: `加载管控数据失败：${error.message}` };
  }
  const target = activeRoot || root;
  paint(target);
}

function renderAccess(root) {
  const access = model.access;
  if (!access) {
    return `
      <section class="panel dsu-access-panel">
        <div class="detail-header compact-header">
          <div><h2 class="panel-title">用户权限与管控</h2>
            <p class="muted">为每个用户配置 DS 网关动作权限与频率限额，删除类动作默认仅对白名单用户开放；配置后「下发策略」到网关真正生效。</p>
          </div>
        </div>
        ${model.accessStatus ? `<div class="sandbox-status error"><strong>${escapeHtml(model.accessStatus.text)}</strong></div>` : `<div class="sandbox-status"><span class="btn-spinner"></span>加载管控数据…</div>`}
      </section>`;
  }
  const meta = access.meta || {};
  return `
    <section class="panel dsu-access-panel" data-access-section="true">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">用户权限与管控</h2>
          <p class="muted">权限按用户名配置并绑定 Token；删除/禁用类动作默认仅对开放删除权限的用户可用。改完记得「下发策略」，否则网关仍按旧策略执行。</p>
        </div>
        <div class="button-group"><button class="primary" id="dsu-access-reload">刷新</button></div>
      </div>
      ${renderAccessStatus(access)}
      <div class="dsu-access-grid">
        ${renderGlobalCard(access)}
        ${renderEvaluateCard(access, meta)}
      </div>
      ${renderViolationsCard(access)}
      ${renderUsersCard(access, meta)}
      ${renderPublishCard(access)}
    </section>
  `;
}

function renderAccessStatus(access) {
  if (model.accessStatus) {
    const type = model.accessStatus.type === "error" ? "error" : model.accessStatus.type === "warn" ? "warn" : "success";
    return `<div class="sandbox-status ${type}"><strong>${escapeHtml(model.accessStatus.text)}</strong></div>`;
  }
  const p = access.policy || {};
  const tokens = Object.keys((access.gatewayPreview && access.gatewayPreview.tokens) || {}).length;
  const configured = Object.keys(p.users || {}).length;
  const violationCount = (access.violations || []).length;
  const status = p.enforcement ? `已启用拦截 · ${tokens} 个 Token · ${configured} 个已配置用户` : `已停用拦截（仅保存配置，网关不拦截）`;
  const warn = violationCount ? ` · <strong class="chip chip-danger">${violationCount} 条违规</strong>` : "";
  return `<div class="sandbox-status success"><strong>管控状态：${escapeHtml(status)}</strong><span>审计快照 ${escapeHtml(String((access.meta && access.meta.rowCount) || 0))} 条${warn}</span></div>`;
}

function renderGlobalCard(access) {
  const p = access.policy || {};
  const limits = p.globalLimits || {};
  const roles = (access.meta && access.meta.roles) || ["readonly", "operator", "power", "admin"];
  const roleLabels = (access.meta && access.meta.roleLabels) || {};
  return `
    <div class="dsu-access-card">
      <h3 class="dsu-access-card-title">全局策略</h3>
      <div class="dsu-access-field">
        <label class="check"><input type="checkbox" id="dsu-global-enforce" ${p.enforcement ? "checked" : ""}> <strong>网关强制执行</strong></label>
        <span class="muted">开启后网关按策略拦截违规动作；关闭则仅保存配置不拦截。</span>
      </div>
      <div class="dsu-access-field">
        <label class="check"><input type="checkbox" id="dsu-global-unknown" ${p.enforceUnknown ? "checked" : ""}> 未知 Token 仅允许只读</label>
        <span class="muted">未绑定到任何用户的 Token 只允许读取类动作，写/删除/触发被拒绝。</span>
      </div>
      <div class="dsu-access-field">
        <label>未配置用户的默认角色
          <select id="dsu-global-role">${roles.map((r) => `<option value="${r}" ${p.defaultRole === r ? "selected" : ""}>${escapeHtml(roleLabels[r] || r)}</option>`).join("")}</select>
        </label>
      </div>
      <div class="dsu-limit-title">全局限额（超出即拦截）</div>
      <div class="dsu-limit-grid">${limitInputs(limits, "dsu-global-")}</div>
      <div class="button-group dsu-access-actions">
        <button class="primary" id="dsu-save-global">保存全局策略</button>
      </div>
    </div>
  `;
}

function limitInputs(values = {}, prefix = "") {
  const labels = {
    maxActionsPerHour: "总操作/小时",
    maxActionsPerDay: "总操作/日",
    maxCreatesPerHour: "新建/小时",
    maxCreatesPerDay: "新建/日",
    maxDeletesPerDay: "删除禁用/日",
    maxTriggersPerHour: "触发/小时",
  };
  return Object.keys(labels).map((key) => `
    <label class="dsu-limit-item">${labels[key]}<input class="input" type="number" min="0" data-limit-key="${key}" data-limit-prefix="${prefix}" value="${values[key] != null ? escapeHtml(String(values[key])) : ""}"></label>
  `).join("");
}

function renderEvaluateCard(access, meta) {
  const actions = Object.keys(meta.actionClasses || {}).sort();
  const roles = meta.roles || [];
  return `
    <div class="dsu-access-card">
      <h3 class="dsu-access-card-title">模拟校验</h3>
      <p class="muted">输入用户名或 Token，选择动作，查看按当前策略是否放行。</p>
      <div class="dsu-access-field">
        <label>用户名或 Token<input class="input" id="dsu-eval-user" placeholder="如 jiangchuanchen 或 Token 前 8 位"></label>
      </div>
      <div class="dsu-access-field">
        <label>动作<select class="input" id="dsu-eval-action">${actions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(actionLabel(a))}</option>`).join("")}</select></label>
      </div>
      <div class="dsu-access-field">
        <label>国家<select class="input" id="dsu-eval-country">${COUNTRY_ORDER.map((c) => `<option value="${c}">${escapeHtml(countryLabel(c))}</option>`).join("")}</select></label>
      </div>
      <div class="button-group dsu-access-actions">
        <button id="dsu-eval-run">校验</button>
      </div>
      <div id="dsu-eval-result"></div>
    </div>
  `;
}

function renderViolationsCard(access) {
  const violations = access.violations || [];
  if (!violations.length) {
    return `<div class="dsu-access-block"><h3 class="dsu-access-card-title">违规记录</h3><p class="muted">当前窗口内未检测到超出限额的操作。</p></div>`;
  }
  const rows = violations.slice(0, 100).map((v) => `
    <tr>
      <td><b>${escapeHtml(v.username)}</b></td>
      <td>${escapeHtml(v.metricLabel || v.metric)}</td>
      <td><span class="chip chip-danger">${v.actual} / ${v.limit}</span></td>
      <td class="muted">${escapeHtml(v.windowType === "hour" ? `${v.window} 时` : v.window)}</td>
      <td><button class="secondary small" data-violation-block="${escapeHtml(v.username)}">封锁该用户</button></td>
    </tr>`).join("");
  return `
    <div class="dsu-access-block">
      <div class="detail-header compact-header">
        <div><h3 class="dsu-access-card-title">违规记录（超出限额）</h3>
          <p class="muted">基于审计快照统计最近 7 天内任一小时/当日窗口超限的情况。</p>
        </div>
      </div>
      <div class="dsu-table-wrap"><table class="ds-table">
        <thead><tr><th>用户</th><th>指标</th><th>实际/上限</th><th>窗口</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
  `;
}

function renderUsersCard(access, meta) {
  const users = access.users || [];
  const roles = meta.roles || [];
  const roleLabels = meta.roleLabels || {};
  const configured = users.filter((u) => u.configured).length;
  return `
    <div class="dsu-access-block">
      <div class="detail-header compact-header">
        <div><h3 class="dsu-access-card-title">用户列表（${users.length} 人 · 已配置 ${configured} 人）</h3>
          <p class="muted">打开行可配置角色 / 删除权限 / 动作黑名单 / 独立限额；未配置用户按「默认角色」执行。</p>
        </div>
        <div class="button-group">
          <button id="dsu-add-user">新增用户</button>
        </div>
      </div>
      ${users.length ? `<div class="dsu-user-list">${users.map((u) => renderUserRow(u, roles, roleLabels)).join("")}</div>` : `<p class="muted">暂无用户数据（需先刷新使用统计生成审计快照）。</p>`}
    </div>
  `;
}

function renderUserRow(user, roles, roleLabels) {
  const roleBadge = ROLE_BADGE[user.role] || { cls: "chip", label: user.role || "?" };
  const status = user.status === "blocked"
    ? `<span class="chip chip-danger">已封锁</span>`
    : user.status === "limited"
      ? `<span class="chip chip-danger">超限 ${user.violations.length}</span>`
      : `<span class="chip chip-ok">正常</span>`;
  const delBadge = user.deleteAllowed ? `<span class="chip chip-danger">可删除</span>` : `<span class="chip">禁删除</span>`;
  const configBadge = user.configured ? "" : `<span class="chip chip-warn">默认角色</span>`;
  const limitHtml = limitInputs(user.limits || {}, `u-${encodeURIComponent(user.username)}-`);
  const tokens = (user.tokens || []).slice(0, 4).map((t) => `<code class="dsu-token-tag" title="${escapeHtml(t)}">${escapeHtml(t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t)}</code>`).join(" ");
  const tokenMore = (user.tokens || []).length > 4 ? `<span class="muted">等 ${user.tokens.length} 个</span>` : "";
  const allActions = Object.keys(ACTION_LABELS);
  const selectedDenied = new Set(user.deniedActions || []);
  const actionChips = allActions.map((a) => `<span class="dsu-denied-chip ${selectedDenied.has(a) ? "active" : ""}" data-action="${escapeHtml(a)}" title="${escapeHtml(actionLabel(a))}">${escapeHtml(a)}</span>`).join("");
  return `
    <details class="dsu-user-row" data-username="${escapeHtml(user.username)}">
      <summary>
        <span class="dsu-user-name">${escapeHtml(user.username)}${configBadge}</span>
        <span class="chip ${roleBadge.cls}">${escapeHtml(roleBadge.label)}</span>
        ${delBadge}${status}
        <span class="chip">${(user.tokens || []).length} Token</span>
        <span class="chip">${user.requests} 次</span>
        <span class="dsu-user-summary-actions">
          <button class="secondary small" data-action="block">${user.enabled ? "封锁" : "解封"}</button>
          <button class="secondary small" data-action="remove" ${user.configured ? "" : "disabled"}>移除配置</button>
        </span>
      </summary>
      <div class="dsu-user-edit">
        <div class="dsu-edit-grid">
          <label>角色<select data-field="role">${roles.map((r) => `<option value="${r}" ${user.role === r ? "selected" : ""}>${escapeHtml(roleLabels[r] || r)}</option>`).join("")}</select></label>
          <label class="check"><input type="checkbox" data-field="enabled" ${user.enabled ? "checked" : ""}> 启用</label>
          <label class="check"><input type="checkbox" data-field="deleteAllowed" ${user.deleteAllowed ? "checked" : ""}> 允许删除类操作</label>
          <label>备注<input class="input" data-field="note" placeholder="选填" value="${escapeHtml(user.note || "")}"></label>
        </div>
        <div class="dsu-denied-title">动作黑名单（点击切换，命中的动作即使角色允许也会被拒绝）</div>
        <div class="dsu-denied-chips">${actionChips}</div>
        <div class="dsu-limit-title">该用户独立限额（留空则用全局）</div>
        <div class="dsu-limit-grid">${limitHtml}</div>
        <div class="dsu-edit-tokens">
          <span class="dsu-filter-label">绑定 Token（逗号/空格分隔，可增删）</span>
          <input class="input" data-field="tokens" placeholder="留空=沿用已有绑定" value="${escapeHtml((user.tokens || []).join(", "))}">
          <div class="muted">当前绑定：${tokens} ${tokenMore}</div>
        </div>
        <div class="button-group dsu-access-actions">
          <button class="primary" data-action="save-user">保存该用户</button>
        </div>
      </div>
    </details>
  `;
}

function renderPublishCard(access) {
  const p = access.policy || {};
  const gw = access.gatewayPreview || {};
  const tokenCount = Object.keys(gw.tokens || {}).length;
  return `
    <div class="dsu-access-block dsu-publish-block">
      <div class="detail-header compact-header">
        <div><h3 class="dsu-access-card-title">下发策略到网关</h3>
          <p class="muted">把上面的用户权限与限额打包成 <code>config/ds-scheduler-access-gateway.json</code>，再复制到各国机器 <code>config/access_policy.json</code> 即可生效（或运行 <code>scripts/publish-ds-access-policy.mjs</code> 自动下发）。</p>
        </div>
        <div class="button-group">
          <button class="primary" id="dsu-publish">生成网关策略</button>
        </div>
      </div>
      <div class="dsu-publish-meta">
        <span class="chip">拦截状态：${p.enforcement ? "开启" : "关闭"}</span>
        <span class="chip">包含 Token：${tokenCount}</span>
        <span class="chip">默认角色：${escapeHtml(p.defaultRole || "-")}</span>
      </div>
      <div id="dsu-publish-result"></div>
    </div>
  `;
}

function bindAccessEvents(root) {
  root.querySelector("#dsu-access-reload")?.addEventListener("click", () => loadAccess(root));
  root.querySelector("#dsu-save-global")?.addEventListener("click", () => saveGlobalPolicy(root));
  root.querySelector("#dsu-eval-run")?.addEventListener("click", () => runEvaluate(root));
  root.querySelector("#dsu-publish")?.addEventListener("click", () => publishAccess(root));
  root.querySelector("#dsu-add-user")?.addEventListener("click", () => addUser(root));
  root.querySelectorAll("[data-violation-block]").forEach((btn) => {
    btn.addEventListener("click", () => toggleBlockUser(root, btn.dataset.violationBlock, false));
  });
  root.querySelectorAll("[data-action='block']").forEach((btn) => {
    const row = btn.closest("[data-username]");
    if (!row) return;
    btn.addEventListener("click", () => toggleBlockUser(root, row.dataset.username, null));
  });
  root.querySelectorAll("[data-action='remove']").forEach((btn) => {
    const row = btn.closest("[data-username]");
    if (!row) return;
    btn.addEventListener("click", () => removeUserConfig(root, row.dataset.username));
  });
  root.querySelectorAll("[data-action='save-user']").forEach((btn) => {
    const row = btn.closest("[data-username]");
    if (!row) return;
    btn.addEventListener("click", () => saveUser(root, row));
  });
  root.querySelectorAll(".dsu-denied-chip").forEach((chip) => {
    chip.addEventListener("click", () => chip.classList.toggle("active"));
  });
}

function readGlobalPolicy(root) {
  const p = model.access.policy;
  const limits = {};
  root.querySelectorAll("[data-limit-prefix='dsu-global-']").forEach((input) => {
    limits[input.dataset.limitKey] = input.value === "" ? p.globalLimits?.[input.dataset.limitKey] : Number(input.value);
  });
  return {
    enforcement: Boolean(root.querySelector("#dsu-global-enforce")?.checked),
    enforceUnknown: Boolean(root.querySelector("#dsu-global-unknown")?.checked),
    defaultRole: root.querySelector("#dsu-global-role")?.value || "operator",
    globalLimits: limits,
  };
}

async function saveGlobalPolicy(root) {
  const btn = root.querySelector("#dsu-save-global");
  if (!btn || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  try {
    await apiPut("/api/ds-scheduler/access/policy", readGlobalPolicy(root), { timeoutMs: 30000 });
    model.accessStatus = { type: "ok", text: "全局策略已保存。" };
  } catch (error) {
    model.accessStatus = { type: "error", text: `保存失败：${error.message}` };
  } finally {
    btn.dataset.busy = "0";
  }
  await loadAccess(root);
}

async function runEvaluate(root) {
  const resultEl = root.querySelector("#dsu-eval-result");
  if (!resultEl) return;
  const value = root.querySelector("#dsu-eval-user")?.value?.trim() || "";
  const action = root.querySelector("#dsu-eval-action")?.value || "";
  const country = root.querySelector("#dsu-eval-country")?.value || "";
  // 命中已知用户名 -> 按用户名校验；否则当作 Token 校验。
  const knownUsers = new Set((model.access.users || []).map((u) => u.username));
  const payload = knownUsers.has(value)
    ? { username: value, action, country }
    : { token: value, action, country };
  resultEl.innerHTML = `<div class="sandbox-status"><span class="btn-spinner"></span>校验中…</div>`;
  try {
    const decision = await apiPost("/api/ds-scheduler/access/evaluate", payload, { timeoutMs: 30000 });
    const ok = decision.allowed;
    resultEl.innerHTML = `
      <div class="sandbox-status ${ok ? "success" : "error"}">
        <strong>${ok ? "✅ 放行" : "🚫 拦截"}</strong>
        <span>${escapeHtml(decision.message || (ok ? "该用户可按当前策略执行该动作。" : "不符合当前策略。"))}</span>
        ${decision.code ? `<code class="dsu-code">${escapeHtml(decision.code)}</code>` : ""}
      </div>`;
  } catch (error) {
    resultEl.innerHTML = `<div class="sandbox-status error"><strong>校验失败</strong><span>${escapeHtml(error.message)}</span></div>`;
  }
}

async function publishAccess(root) {
  const btn = root.querySelector("#dsu-publish");
  const resultEl = root.querySelector("#dsu-publish-result");
  if (!btn || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.innerHTML = `<span class="btn-spinner"></span>生成中…`;
  try {
    const res = await apiPost("/api/ds-scheduler/access/publish", {}, { timeoutMs: 40000 });
    const warnings = (res.summary?.warnings || []).map((w) => `<div class="sandbox-status warn">⚠ ${escapeHtml(w.message)}</div>`).join("");
    resultEl.innerHTML = `
      <div class="sandbox-status success">
        <strong>已生成网关策略</strong>
        <span>${escapeHtml(res.summary?.deployHint || "")}</span>
        <span class="muted">文件：<code>${escapeHtml(res.file || "")}</code></span>
      </div>${warnings}`;
  } catch (error) {
    resultEl.innerHTML = `<div class="sandbox-status error"><strong>生成失败</strong><span>${escapeHtml(error.message)}</span></div>`;
  } finally {
    btn.dataset.busy = "0";
    btn.textContent = "生成网关策略";
  }
}

async function toggleBlockUser(root, username, force) {
  if (!username) return;
  const current = (model.access.users || []).find((u) => u.username === username);
  const enabled = force === null ? !(current ? current.enabled : true) : force;
  const verb = enabled ? "解封" : "封锁";
  if (!window.confirm(`${verb}用户 ${username}？${enabled ? "解封后该用户可继续使用网关。" : "封锁后该用户通过网关的所有操作都会被拒绝。"}`)) return;
  try {
    await apiPut(`/api/ds-scheduler/access/users/${encodeURIComponent(username)}`, { enabled, username }, { timeoutMs: 30000 });
    model.accessStatus = { type: "ok", text: `用户 ${username} 已${verb}。` };
  } catch (error) {
    model.accessStatus = { type: "error", text: `${verb}失败：${error.message}` };
  }
  await loadAccess(root);
}

async function removeUserConfig(root, username) {
  if (!username) return;
  if (!window.confirm(`移除用户 ${username} 的显式配置？移除后按默认角色执行（不会删除审计记录）。`)) return;
  try {
    await apiDelete(`/api/ds-scheduler/access/users/${encodeURIComponent(username)}`, {}, { timeoutMs: 30000 });
    model.accessStatus = { type: "ok", text: `已移除 ${username} 的显式配置。` };
  } catch (error) {
    model.accessStatus = { type: "error", text: `移除失败：${error.message}` };
  }
  await loadAccess(root);
}

async function saveUser(root, row) {
  const username = row.dataset.username;
  if (!username) return;
  const limits = {};
  row.querySelectorAll("[data-limit-prefix]").forEach((input) => {
    const value = input.value.trim();
    if (value !== "") limits[input.dataset.limitKey] = Number(value);
  });
  const deniedActions = [...row.querySelectorAll(".dsu-denied-chip.active")].map((c) => c.dataset.action);
  const payload = {
    username,
    role: row.querySelector("[data-field='role']")?.value,
    enabled: Boolean(row.querySelector("[data-field='enabled']")?.checked),
    deleteAllowed: Boolean(row.querySelector("[data-field='deleteAllowed']")?.checked),
    note: row.querySelector("[data-field='note']")?.value || "",
    deniedActions,
    limits,
  };
  // 绑定 Token：留空 = 沿用已有绑定（不覆盖）；填写则整体替换。
  const tokensValue = (row.querySelector("[data-field='tokens']")?.value || "").trim();
  if (tokensValue) {
    payload.tokens = tokensValue.split(/[\s,，]+/).map((t) => t.trim()).filter(Boolean);
  }
  const btn = row.querySelector("[data-action='save-user']");
  if (btn) btn.dataset.busy = "1";
  try {
    await apiPut(`/api/ds-scheduler/access/users/${encodeURIComponent(username)}`, payload, { timeoutMs: 30000 });
    model.accessStatus = { type: "ok", text: `用户 ${username} 已保存。` };
  } catch (error) {
    model.accessStatus = { type: "error", text: `保存失败：${error.message}` };
  }
  if (btn) btn.dataset.busy = "0";
  await loadAccess(root);
}

async function addUser(root) {
  const username = window.prompt("新增用户的用户名（DS 平台用户名）：");
  if (!username) return;
  const token = window.prompt("绑定 Token（可选，可先留空再在行内配置）：") || "";
  try {
    await apiPut(`/api/ds-scheduler/access/users/${encodeURIComponent(username)}`, {
      username,
      tokens: token ? [token] : [],
      role: model.access?.policy?.defaultRole || "operator",
      enabled: true,
      deleteAllowed: false,
    }, { timeoutMs: 30000 });
    model.accessStatus = { type: "ok", text: `已新增用户 ${username}。` };
  } catch (error) {
    model.accessStatus = { type: "error", text: `新增失败：${error.message}` };
  }
  await loadAccess(root);
}

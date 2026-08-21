import { apiGet, apiPost } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const SOURCE_LABELS = { "codex-skill": "Codex Skill", n8n: "n8n", "duty-platform": "值班平台" };
const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
let model = { report: null, config: null, status: null, loading: false, days: 30, countryRange: {} };

function countryLabel(code) {
  return COUNTRY_LABELS[code] || code || "-";
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

export function renderDsSchedulerUsage(root) {
  root.innerHTML = `<section class="panel"><p class="muted">正在加载网关使用统计…</p></section>`;
  load(root);
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
  paint(root);
}

function paint(root) {
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
    ${report ? renderMain(report) : ""}
  `;
  root.querySelector("#dsu-refresh")?.addEventListener("click", () => refresh(root));
  root.querySelectorAll("[data-role='country-from'], [data-role='country-to']").forEach((input) => {
    input.addEventListener("change", () => {
      const country = input.dataset.country;
      const fromEl = root.querySelector(`[data-role='country-from'][data-country='${country}']`);
      const toEl = root.querySelector(`[data-role='country-to'][data-country='${country}']`);
      model.countryRange[country] = {
        from: fromEl ? fromEl.value : "",
        to: toEl ? toEl.value : "",
      };
      paint(root);
    });
  });
  root.querySelectorAll("[data-token-action='copy']").forEach((btn) => {
    btn.addEventListener("click", () => copyToken(btn));
  });
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

function renderMain(report) {
  return `
    <section class="panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">国家使用分布</h2>
          <p class="muted">${report.generatedAt ? `最近更新：${new Date(report.generatedAt).toLocaleString("zh-CN")}` : ""} · 展开各国可单独设置统计时间范围</p>
        </div>
        <div class="button-group">
          <button class="primary" id="dsu-refresh">刷新数据</button>
        </div>
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
  const countries = report.countryUsage || [];
  if (!countries.length) {
    return renderEmptyHint("暂无数据");
  }
  return `
    <div class="dsu-country-list">
      ${countries.map((c) => renderCountry(c)).join("")}
    </div>
  `;
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
  let requests = 0, success = 0, failed = 0, riskActions = 0;
  const operators = new Map();
  const actions = new Map();
  const tokens = new Set();
  for (const d of daily) {
    requests += d.requests;
    success += d.success;
    failed += d.failed;
    riskActions += d.riskActions;
    for (const op of (d.operators || [])) {
      const agg = operators.get(op.token) || { token: op.token, requests: 0, success: 0, failed: 0, riskActions: 0, durationTotalMs: 0, actions: new Map(), tools: new Set() };
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
    uniqueOperators: opList.length,
    operators: opList,
    tokens: [...tokens].sort(),
    actions: Object.fromEntries([...actions.entries()].sort((a, b) => b[1] - a[1])),
    daily,
  };
}

function renderCountry(c) {
  const range = model.countryRange[c.country] || countryDefaultRange(c);
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
          <span class="dsu-filter-label">按天筛选</span>
          <label>开始<input type="date" class="input" data-role="country-from" data-country="${escapeHtml(c.country)}" value="${escapeHtml(range.from)}"></label>
          <label>结束<input type="date" class="input" data-role="country-to" data-country="${escapeHtml(c.country)}" value="${escapeHtml(range.to)}"></label>
          <span class="muted">覆盖 ${data.daily.length} 天</span>
        </div>
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
        ${renderBreakdown("动作分布", data.actions, (key) => key)}
        <div class="dsu-table-wrap">
          <table class="ds-table dsu-operator-table">
            <thead>
              <tr><th>Token</th><th>调用次数</th><th>成功/失败</th><th>成功率</th><th>风险操作</th><th>使用工具</th><th>平均耗时</th><th>主要动作</th></tr>
            </thead>
            <tbody>
              ${data.operators.map((op) => renderCountryOperatorRow(op)).join("")}
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
  return `
    <tr>
      <td><code class="dsu-token-tag">${escapeHtml(op.token)}</code></td>
      <td>${op.requests}</td>
      <td>${op.success} / ${op.failed}</td>
      <td><span class="chip ${rateClass(op.successRate)}">${op.successRate}%</span></td>
      <td>${op.riskActions}</td>
      <td>${(op.tools || []).map((t) => escapeHtml(t)).join("、") || "-"}</td>
      <td>${fmtDuration(op.avgDurationMs)}</td>
      <td class="muted">${Object.entries(op.actions || {}).slice(0, 3).map(([a, n]) => `${escapeHtml(a)}×${n}`).join(" · ") || "-"}</td>
    </tr>
  `;
}

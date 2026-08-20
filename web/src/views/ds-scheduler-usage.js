import { apiGet, apiPost } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const SOURCE_LABELS = { "codex-skill": "Codex Skill", n8n: "n8n", "duty-platform": "值班平台" };
let model = { report: null, status: null, loading: false, days: 30 };

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
  } finally {
    model.loading = false;
  }
  paint(root);
}

async function refresh(root) {
  const btn = root.querySelector("#dsu-refresh");
  if (!btn || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.innerHTML = `<span class="btn-spinner"></span>刷新中…`;
  try {
    model.report = await apiPost("/api/ds-scheduler/usage/refresh", { days: model.days }, { timeoutMs: 120000 });
    model.status = { type: "ok", text: "已从数据源刷新最新使用情况。" };
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
        <p class="page-note">统计 n8n <code>ds-scheduler-router</code> 网关的审计记录：每天谁在使用、调用了哪些动作、成功率与风险操作等。${report ? sourceBadge(report) : ""}</p>
      </div>
      ${renderHeroStats(report)}
    </div>
    ${renderStatus(report)}
    ${report ? renderMain(report, root) : ""}
  `;
  root.querySelector("#dsu-refresh")?.addEventListener("click", () => refresh(root));
  root.querySelector("#dsu-days")?.addEventListener("change", (event) => {
    model.days = Number(event.target.value) || 30;
    load(root);
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

function renderStatus(report) {
  if (report?.error || model.status?.type === "error") {
    const reason = report?.refreshError || model.status?.text || "数据源不可达";
    return `<div class="sandbox-status error"><strong>暂时无法获取数据</strong><span>${escapeHtml(reason)}</span></div>`;
  }
  if (model.status?.type === "ok") {
    return `<div class="sandbox-status success"><strong>${escapeHtml(model.status.text)}</strong></div>`;
  }
  return "";
}

function renderMain(report, root) {
  return `
    <section class="panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">每日使用明细</h2>
          <p class="muted">${report.generatedAt ? `最近更新：${new Date(report.generatedAt).toLocaleString("zh-CN")}` : ""}</p>
        </div>
        <div class="button-group">
          <select id="dsu-days" class="input">
            ${[7, 14, 30].map((d) => `<option value="${d}" ${model.days === d ? "selected" : ""}>近 ${d} 天</option>`).join("")}
          </select>
          <button class="primary" id="dsu-refresh">刷新数据</button>
        </div>
      </div>
      ${renderDays(report)}
    </section>
  `;
}

function renderDays(report) {
  if (report?.error) {
    return renderEmptyHint("数据源不可达");
  }
  if (!report.days || report.days.length === 0) {
    return renderEmptyHint("暂无数据");
  }
  return `
    <div class="dsu-day-list">
      ${report.days.map((day, index) => renderDay(day, index)).join("")}
    </div>
  `;
}

function renderEmptyHint(kind) {
  if (kind === "数据源不可达") {
    return `
      <div class="notice">
        <strong>数据源不可达</strong>
        <span>当前取数方式为 gateway（n8n 网关）。请确认：① n8n 已导入并激活 <code>n8n-ds-usage-report.json</code>；② 平台能访问 <code>DS_USAGE_WEBHOOK_URL</code> 指向的 n8n；③ n8n Variables 已配置 <code>DS_AUDIT_DB_PASSWORD</code>。也可改用 <code>ssh</code> 直连跳板机，或导入本地快照后查看缓存。</span>
      </div>
    `;
  }
  return `
    <div class="notice">
      <strong>暂无数据</strong>
      <span>当前统计周期内没有审计记录。请确认网关注册了审计写入，且查询窗口内有调用。</span>
    </div>
  `;
}

function renderDay(day, index) {
  return `
    <details class="dsu-day" ${index === 0 ? "open" : ""}>
      <summary>
        <span class="dsu-day-date">${escapeHtml(day.date)}</span>
        <span class="dsu-day-meta">
          <span class="chip">${day.requests} 次</span>
          <span class="chip">${day.uniqueOperators} 人</span>
          <span class="chip ${rateClass(day.successRate)}">成功率 ${day.successRate}%</span>
          ${day.riskActions ? `<span class="chip chip-danger">风险 ${day.riskActions}</span>` : ""}
        </span>
      </summary>
      <div class="dsu-day-body">
        <div class="dsu-row">
          <div class="dsu-kpi">
            ${kpi("成功 / 失败", `${day.success} / ${day.failed}`)}
            ${kpi("风险操作", day.riskActions)}
            ${kpi("国家", Object.keys(day.countries).length)}
          </div>
        </div>
        ${renderBreakdown("国家分布", day.countries, countryLabel)}
        ${renderBreakdown("来源系统", day.sources, sourceLabel)}
        ${renderBreakdown("动作分布", day.actions, (key) => key)}
        <div class="dsu-table-wrap">
          <table class="ds-table dsu-operator-table">
            <thead>
              <tr><th>操作人</th><th>调用次数</th><th>成功/失败</th><th>成功率</th><th>风险操作</th><th>涉及国家</th><th>来源</th><th>平均耗时</th><th>主要动作</th></tr>
            </thead>
            <tbody>
              ${day.operators.map((op) => renderOperatorRow(op)).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </details>
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

function renderOperatorRow(op) {
  return `
    <tr>
      <td><strong>${escapeHtml(op.operator)}</strong></td>
      <td>${op.requests}</td>
      <td>${op.success} / ${op.failed}</td>
      <td><span class="chip ${rateClass(op.successRate)}">${op.successRate}%</span></td>
      <td>${op.riskActions}</td>
      <td>${(op.countries || []).map((c) => `<span class="mini-tag">${escapeHtml(countryLabel(c))}</span>`).join("") || "-"}</td>
      <td>${(op.sources || []).map((s) => `<span class="mini-tag">${escapeHtml(sourceLabel(s))}</span>`).join("") || "-"}</td>
      <td>${fmtDuration(op.avgDurationMs)}</td>
      <td class="muted">${Object.entries(op.actions || {}).slice(0, 3).map(([a, n]) => `${escapeHtml(a)}×${n}`).join(" · ") || "-"}</td>
    </tr>
  `;
}

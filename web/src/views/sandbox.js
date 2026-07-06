import { apiPost } from "../api.js";
import { findSelectedCard, findSelectedDashboard, findSelectedRule, state } from "../state.js";
import {
  describeRule,
  escapeHtml,
  json,
  ruleCards,
  ruleDashboard,
  ruleScope,
  ruleTypeLabel,
} from "../view-utils.js";

export function renderSandbox(root) {
  const dashboards = state.inventory?.dashboards || [];
  const rules = state.rulesConfig?.rules || [];
  const countries = state.countries?.countries || [];
  const dashboard = findSelectedDashboard();
  const card = findSelectedCard();
  const rule = findSelectedRule();
  const rows = state.sandboxRows || card?.sampleRows || [];

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">规则告警试跑</h1>
        <p class="page-note">在本机用已缓存的 Metabase sampleRows 试跑当前规则，判断这条规则是否会产生告警；不访问线上 API，不发送通知。</p>
      </div>
      <button class="primary" id="run-sandbox">执行试跑</button>
    </div>
    <div class="notice">
      <strong>试跑后会得到什么</strong>
      <span>点击“执行试跑”后，平台会把左侧样例 rows 交给所选规则引擎，输出“会生成告警 / 不会生成告警”、命中的规则消息和读取行数。它用于调试告警规则，不会保存结果，也不会推送 TV/webhook。</span>
    </div>
    <div class="toolbar wide-toolbar">
      <label>
        看板
        <select id="dashboard-select">
          ${dashboards.map((item) => `<option value="${escapeHtml(item.uuid || "")}" ${item === dashboard ? "selected" : ""}>${escapeHtml(item.countryCode || "")} ${escapeHtml(item.title || item.sourcePanelTitle || "")}</option>`).join("")}
        </select>
      </label>
      <label>
        卡片
        <select id="card-select">
          ${(dashboard?.cards || []).map((item) => `<option value="${escapeHtml(item.cardId || "")}" ${item === card ? "selected" : ""}>${escapeHtml(item.title || "")}</option>`).join("")}
        </select>
      </label>
      <label>
        规则
        <select id="rule-select">
          ${rules.map((item, index) => `<option value="${index}" ${item === rule ? "selected" : ""}>#${index + 1} ${escapeHtml(ruleTypeLabel(item.type))}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="sandbox-layout">
      <section class="panel">
        <h2 class="panel-title">本次试跑对象</h2>
        <div class="info-grid single">
          ${infoItem("国家", dashboard?.countryName || dashboard?.countryCode || "-")}
          ${infoItem("Metabase 看板", dashboard?.title || dashboard?.sourcePanelTitle || "-")}
          ${infoItem("卡片", card?.title || "-")}
          ${infoItem("样例行数", String(rows.length))}
        </div>
        <h3 class="section-title">样例 rows</h3>
        ${renderRowsTable(rows)}
        <details class="advanced compact">
          <summary>高级：编辑本次试跑 rows</summary>
          <textarea id="sandbox-rows-json" class="medium-editor">${escapeHtml(json(rows))}</textarea>
        </details>
      </section>
      <section class="panel">
        <h2 class="panel-title">规则解释</h2>
        ${renderRuleSummary(rule, countries)}
        <div id="sandbox-result" class="result-box">
          ${state.sandboxResult ? renderResult(state.sandboxResult) : `<p class="muted">选择看板、卡片和规则后，点击“执行试跑”查看这条规则是否会生成告警消息。</p>`}
        </div>
      </section>
    </div>
  `;

  root.querySelector("#dashboard-select")?.addEventListener("change", (event) => {
    state.selected.dashboardUuid = event.target.value;
    state.selected.cardId = "";
    state.sandboxRows = null;
    state.sandboxResult = null;
    renderSandbox(root);
  });
  root.querySelector("#card-select")?.addEventListener("change", (event) => {
    state.selected.cardId = event.target.value;
    state.sandboxRows = null;
    state.sandboxResult = null;
    renderSandbox(root);
  });
  root.querySelector("#rule-select")?.addEventListener("change", (event) => {
    state.selected.ruleIndex = Number(event.target.value);
    state.sandboxResult = null;
    renderSandbox(root);
  });
  root.querySelector("#run-sandbox")?.addEventListener("click", async () => {
    const edited = root.querySelector("#sandbox-rows-json")?.value;
    const nextRows = edited ? JSON.parse(edited) : rows;
    state.sandboxRows = nextRows;
    state.sandboxResult = await apiPost("/api/sandbox/evaluate", {
      dashboard,
      card,
      rule,
      rows: nextRows,
    });
    renderSandbox(root);
  });
}

function renderRuleSummary(rule, countries) {
  if (!rule) {
    return `<p class="muted">暂无规则。</p>`;
  }
  return `
    <p class="rule-explain">${escapeHtml(describeRule(rule))}</p>
    <div class="info-grid single">
      ${infoItem("规则类型", ruleTypeLabel(rule.type))}
      ${infoItem("适用国家", ruleScope(rule, countries))}
      ${infoItem("目标看板", ruleDashboard(rule))}
      ${infoItem("目标卡片", ruleCards(rule))}
    </div>
    <details class="advanced compact">
      <summary>查看本规则 JSON</summary>
      <pre class="code">${escapeHtml(json(rule))}</pre>
    </details>
  `;
}

function renderRowsTable(rows) {
  if (!rows?.length) {
    return `<p class="muted">当前卡片没有缓存样例行，可在高级区手动输入 rows 后试跑。</p>`;
  }
  const columns = Object.keys(rows[0] || {}).slice(0, 8);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.slice(0, 6).map((row) => `
            <tr>${columns.map((column) => `<td>${escapeHtml(formatCell(row[column]))}</td>`).join("")}</tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${rows.length > 6 ? `<p class="muted">仅展示前 6 行，共 ${rows.length} 行。</p>` : ""}
  `;
}

function renderResult(result) {
  const messages = result.messages || [];
  return `
    <h3 class="section-title">试跑结果</h3>
    <div class="result-summary ${result.matched ? "danger" : "ok"}">
      <strong>${result.matched ? "会生成告警" : "不会生成告警"}</strong>
      <span>本次读取 ${result.rowCount} 行样例数据，产出 ${messages.length} 条规则消息。这里仅用于调试规则，不会写入巡检结果，也不会发送通知。</span>
    </div>
    ${messages.length ? `
      <ul class="plain-list">
        ${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}
      </ul>
    ` : `<p class="muted">这组样例 rows 在当前规则下没有异常消息。</p>`}
  `;
}

function infoItem(label, value) {
  return `
    <div class="info-item">
      <span>${label}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function formatCell(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return String(value);
}

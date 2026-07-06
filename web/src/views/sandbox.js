import { apiPost } from "../api.js";
import { findSelectedCard, findSelectedDashboard, findSelectedRule, json, state } from "../state.js";

export function renderSandbox(root) {
  const dashboards = state.inventory?.dashboards || [];
  const rules = state.rulesConfig?.rules || [];
  const dashboard = findSelectedDashboard();
  const card = findSelectedCard();
  const rule = findSelectedRule();
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">离线试跑</h1>
        <p class="page-note">只使用本地 sampleRows 和规则引擎，不访问线上 API，不发送通知。</p>
      </div>
      <button class="primary" id="run-sandbox">执行试跑</button>
    </div>
    <div class="toolbar">
      <select id="dashboard-select">
        ${dashboards.map((item) => `<option value="${item.uuid || ""}" ${item === dashboard ? "selected" : ""}>${item.countryCode || ""} ${item.title || item.sourcePanelTitle || ""}</option>`).join("")}
      </select>
      <select id="card-select">
        ${(dashboard?.cards || []).map((item) => `<option value="${item.cardId}" ${item === card ? "selected" : ""}>${item.title}</option>`).join("")}
      </select>
      <select id="rule-select">
        ${rules.map((item, index) => `<option value="${index}" ${item === rule ? "selected" : ""}>#${index + 1} ${item.type || "unknown"}</option>`).join("")}
      </select>
    </div>
    <div class="split">
      <section class="panel">
        <h2 class="panel-title">输入 rows</h2>
        <pre class="code">${escapeHtml(json(card?.sampleRows || []))}</pre>
      </section>
      <section class="panel">
        <h2 class="panel-title">规则与结果</h2>
        <pre class="code">${escapeHtml(json(rule || {}))}</pre>
        <div id="sandbox-result" style="margin-top:12px">
          ${state.sandboxResult ? renderResult(state.sandboxResult) : `<p class="muted">尚未试跑。</p>`}
        </div>
      </section>
    </div>
  `;
  root.querySelector("#dashboard-select")?.addEventListener("change", (event) => {
    state.selected.dashboardUuid = event.target.value;
    state.selected.cardId = "";
    renderSandbox(root);
  });
  root.querySelector("#card-select")?.addEventListener("change", (event) => {
    state.selected.cardId = event.target.value;
    renderSandbox(root);
  });
  root.querySelector("#rule-select")?.addEventListener("change", (event) => {
    state.selected.ruleIndex = Number(event.target.value);
    renderSandbox(root);
  });
  root.querySelector("#run-sandbox")?.addEventListener("click", async () => {
    state.sandboxResult = await apiPost("/api/sandbox/evaluate", {
      dashboard,
      card,
      rule,
      rows: card?.sampleRows || [],
    });
    renderSandbox(root);
  });
}

function renderResult(result) {
  return `
    <div class="panel" style="background:#f9fafb">
      <div>命中状态：<span class="badge ${result.matched ? "danger" : "ok"}">${result.matched ? "命中异常" : "未命中"}</span></div>
      <div style="margin-top:8px">行数：${result.rowCount}</div>
      <pre class="code" style="margin-top:10px">${escapeHtml(json(result.messages))}</pre>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

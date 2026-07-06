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
      <div class="button-group">
        <button id="run-sandbox">离线试跑（不联网）</button>
        <button class="primary" id="run-live-sandbox">真实只读试跑（访问 Metabase）</button>
      </div>
    </div>
    <div class="notice">
      <strong>两种试跑</strong>
      <span>两种试跑都会执行当前选择的规则，只判断“是否会生成告警消息”。这里不保存巡检结果，不修改看板，不发送 TV/webhook。</span>
    </div>
    <div class="trial-compare">
      <article>
        <h2>离线试跑</h2>
        <p>数据来自本机 inventory 里缓存的 sampleRows，完全不访问线上 Metabase。适合先验证规则逻辑、手动改 rows 后复现边界场景。</p>
      </article>
      <article>
        <h2>真实只读试跑</h2>
        <p>临时访问 Metabase public dashcard JSON 拉取该卡片最新 rows，再用同一条规则判断。只读访问，不会修改 Metabase 看板，也不会发送通知。</p>
      </article>
    </div>
    ${renderSandboxStatus()}
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
        <h3 class="section-title">${state.sandboxResult?.source === "metabase" ? "最近一次真实返回 rows" : "样例 rows"}</h3>
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
          ${state.sandboxResult ? renderResult(state.sandboxResult) : `<p class="muted">选择看板、卡片和规则后，点击“离线试跑”或“真实只读试跑”查看这条规则是否会生成告警消息。</p>`}
        </div>
      </section>
    </div>
  `;

  root.querySelector("#dashboard-select")?.addEventListener("change", (event) => {
    state.selected.dashboardUuid = event.target.value;
    state.selected.cardId = "";
    state.sandboxRows = null;
    clearSandboxFeedback();
    renderSandbox(root);
  });
  root.querySelector("#card-select")?.addEventListener("change", (event) => {
    state.selected.cardId = event.target.value;
    state.sandboxRows = null;
    clearSandboxFeedback();
    renderSandbox(root);
  });
  root.querySelector("#rule-select")?.addEventListener("change", (event) => {
    state.selected.ruleIndex = Number(event.target.value);
    clearSandboxFeedback();
    renderSandbox(root);
  });
  root.querySelector("#run-sandbox")?.addEventListener("click", async () => {
    try {
      const edited = root.querySelector("#sandbox-rows-json")?.value;
      const nextRows = edited ? JSON.parse(edited) : rows;
      state.sandboxRows = nextRows;
      state.sandboxResult = null;
      state.sandboxError = "";
      state.sandboxStatus = {
        type: "loading",
        title: "正在离线试跑",
        detail: "使用左侧 sampleRows 和当前规则在本机计算，不访问线上服务。",
      };
      renderSandbox(root);
      state.sandboxResult = await apiPost("/api/sandbox/evaluate", {
        dashboard,
        card,
        rule,
        rows: nextRows,
      });
      state.sandboxStatus = buildSuccessStatus(state.sandboxResult);
    } catch (error) {
      state.sandboxResult = null;
      state.sandboxError = formatSandboxError(error);
      state.sandboxStatus = {
        type: "error",
        title: "离线试跑失败",
        detail: "通常是高级区 rows JSON 格式不正确，或当前看板、卡片、规则没有选完整。",
      };
    }
    renderSandbox(root);
  });
  root.querySelector("#run-live-sandbox")?.addEventListener("click", async () => {
    try {
      state.sandboxResult = null;
      state.sandboxError = "";
      state.sandboxStatus = {
        type: "loading",
        title: "正在真实只读试跑",
        detail: "正在访问 Metabase public dashcard JSON 拉取最新 rows，只读取数据，不修改看板。",
      };
      renderSandbox(root);
      state.sandboxResult = await apiPost("/api/sandbox/evaluate-live", {
        dashboard,
        card,
        rule,
      });
      state.sandboxRows = state.sandboxResult.rows || [];
      state.sandboxStatus = buildSuccessStatus(state.sandboxResult);
    } catch (error) {
      state.sandboxResult = null;
      state.sandboxError = formatSandboxError(error);
      state.sandboxStatus = {
        type: "error",
        title: "真实只读试跑失败",
        detail: "常见原因是 Metabase public 链接不可访问、卡片参数不完整、网络超时，或服务端无法解析返回内容。",
      };
    }
    renderSandbox(root);
  });
}

function clearSandboxFeedback() {
  state.sandboxResult = null;
  state.sandboxStatus = null;
  state.sandboxError = "";
}

function buildSuccessStatus(result) {
  const mode = result.source === "metabase" ? "真实只读试跑" : "离线试跑";
  return {
    type: "success",
    title: `${mode}完成：${result.matched ? "会生成告警" : "不会生成告警"}`,
    detail: `读取 ${result.rowCount || 0} 行数据，产出 ${(result.messages || []).length} 条规则消息。`,
  };
}

function formatSandboxError(error) {
  if (error instanceof SyntaxError) {
    return `rows JSON 格式错误：${error.message}`;
  }
  if (error?.payload?.errors?.length) {
    return error.payload.errors.join("\n");
  }
  return error?.message || "未知错误";
}

function renderSandboxStatus() {
  if (state.sandboxStatus?.type === "loading") {
    return statusBox(state.sandboxStatus, "正在执行，完成后会自动刷新这里和右侧试跑结果。");
  }
  if (state.sandboxStatus?.type === "success") {
    return statusBox(state.sandboxStatus, "结果只用于调试，不会写入巡检结果，也不会发送通知。");
  }
  if (state.sandboxStatus?.type === "error") {
    return `
      <div class="sandbox-status error">
        <div>
          <strong>${escapeHtml(state.sandboxStatus.title)}</strong>
          <span>${escapeHtml(state.sandboxStatus.detail)}</span>
          <pre>${escapeHtml(state.sandboxError || "-")}</pre>
        </div>
      </div>
    `;
  }
  return `
    <div class="sandbox-status idle">
      <div>
        <strong>点击按钮后这里会显示试跑反馈</strong>
        <span>离线试跑看规则逻辑是否命中；真实只读试跑看 Metabase 当前返回 rows 是否会触发同一条告警规则。</span>
      </div>
    </div>
  `;
}

function statusBox(status, extra) {
  return `
    <div class="sandbox-status ${escapeHtml(status.type)}">
      <div>
        <strong>${escapeHtml(status.title)}</strong>
        <span>${escapeHtml(status.detail || "")}</span>
        <small>${escapeHtml(extra)}</small>
      </div>
    </div>
  `;
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
      <span>${result.source === "metabase" ? "真实只读试跑" : "离线试跑"}读取 ${result.rowCount} 行数据，产出 ${messages.length} 条规则消息。这里仅用于调试规则，不会写入巡检结果，也不会发送通知。</span>
    </div>
    ${result.source === "metabase" ? `
      <div class="info-grid single live-request">
        ${infoItem("Metabase 请求", `${result.request?.baseUrl || "-"} / dashboard ${result.request?.dashboardUuid || "-"} / card ${result.request?.cardId || "-"}`)}
        ${infoItem("参数数量", String(result.request?.parameterCount || 0))}
      </div>
    ` : ""}
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

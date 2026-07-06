import { apiPost } from "../api.js";
import { setRoute, state } from "../state.js";
import { countryLabel, escapeHtml, json, ruleTypeLabel } from "../view-utils.js";

export function renderBatchCheck(root) {
  const countries = state.countries?.countries || [];
  const dashboards = state.inventory?.dashboards || [];
  const selectedCountry = state.selected.countryCode || countries[0]?.code || "";
  const countryDashboards = dashboards.filter((dashboard) => {
    const code = dashboard.countryCode || dashboard.country?.code || "";
    return !selectedCountry || code === selectedCountry;
  });
  const selectedDashboard = countryDashboards.find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || null;
  const result = state.batchCheckResult;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">批量巡检</h1>
        <p class="page-note">按国家或单个看板批量真实只读访问 Metabase，执行当前规则并生成一次巡检结果；不修改看板，不自动发送通知。</p>
      </div>
      <div class="button-group">
        <button class="primary" id="run-batch-check">开始真实只读巡检</button>
      </div>
    </div>
    <div class="notice">
      <strong>安全范围</strong>
      <span>默认最多检查 20 张卡片。建议先按单国家小批量验证，确认规则和通知文案稳定后，再扩大范围。</span>
    </div>
    <section class="panel batch-controls">
      <div class="toolbar wide-toolbar">
        <label>
          国家
          <select id="batch-country">
            ${countries.map((country) => `<option value="${escapeHtml(country.code || "")}" ${country.code === selectedCountry ? "selected" : ""}>${escapeHtml(countryLabel(country, countries))}</option>`).join("")}
          </select>
        </label>
        <label>
          看板范围
          <select id="batch-dashboard">
            <option value="">该国家全部看板</option>
            ${countryDashboards.map((dashboard) => `<option value="${escapeHtml(dashboard.uuid || "")}" ${selectedDashboard === dashboard ? "selected" : ""}>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "")}</option>`).join("")}
          </select>
        </label>
        <label>
          最多卡片数
          <input id="batch-max-cards" type="number" min="1" max="200" value="${escapeHtml(state.batchMaxCards || 20)}">
        </label>
      </div>
      ${renderBatchStatus()}
    </section>
    ${result ? renderBatchResult(result) : `<p class="muted">选择范围后点击“开始真实只读巡检”。</p>`}
  `;

  root.querySelector("#batch-country")?.addEventListener("change", (event) => {
    state.selected.countryCode = event.target.value;
    state.selected.dashboardUuid = "";
    clearBatchFeedback();
    renderBatchCheck(root);
  });
  root.querySelector("#batch-dashboard")?.addEventListener("change", (event) => {
    state.selected.dashboardUuid = event.target.value;
    clearBatchFeedback();
    renderBatchCheck(root);
  });
  root.querySelector("#batch-max-cards")?.addEventListener("input", (event) => {
    state.batchMaxCards = event.target.value;
  });
  root.querySelector("#run-batch-check")?.addEventListener("click", async () => {
    state.batchCheckStatus = {
      type: "loading",
      title: "正在执行批量真实只读巡检",
      detail: "正在访问 Metabase public dashcard JSON 并执行规则，请稍等。",
    };
    state.batchCheckError = "";
    state.batchCheckResult = null;
    renderBatchCheck(root);
    try {
      state.batchCheckResult = await apiPost("/api/batch-check", {
        countryCode: state.selected.countryCode || selectedCountry,
        dashboardUuid: state.selected.dashboardUuid || "",
        maxCards: Number(state.batchMaxCards || 20),
      });
      state.batchCheckStatus = {
        type: "success",
        title: "批量巡检完成",
        detail: `检查 ${state.batchCheckResult.checkedCardCount || 0} 张卡片，发现 ${state.batchCheckResult.anomalyCount || 0} 条异常。`,
      };
    } catch (error) {
      state.batchCheckResult = null;
      state.batchCheckError = error.payload?.errors?.join("\n") || error.message;
      state.batchCheckStatus = {
        type: "error",
        title: "批量巡检失败",
        detail: "请检查看板 public 链接、网络可达性或规则配置。",
      };
    }
    renderBatchCheck(root);
  });
  root.querySelector("#batch-to-notify")?.addEventListener("click", () => {
    state.notifyDraft = buildNotifyDraftFromBatch(result);
    state.notifyPreview = null;
    state.notifyError = "";
    setRoute("/notify-preview");
  });
}

function clearBatchFeedback() {
  state.batchCheckResult = null;
  state.batchCheckStatus = null;
  state.batchCheckError = "";
}

function renderBatchStatus() {
  const status = state.batchCheckStatus;
  if (!status) {
    return "";
  }
  if (status.type === "error") {
    return `
      <div class="sandbox-status error">
        <strong>${escapeHtml(status.title)}</strong>
        <span>${escapeHtml(status.detail || "")}</span>
        <pre>${escapeHtml(state.batchCheckError || "-")}</pre>
      </div>
    `;
  }
  return `
    <div class="sandbox-status ${escapeHtml(status.type)}">
      <strong>${escapeHtml(status.title)}</strong>
      <span>${escapeHtml(status.detail || "")}</span>
    </div>
  `;
}

function renderBatchResult(result) {
  const anomalies = result.anomalies || [];
  return `
    <section class="panel">
      <div class="detail-header compact-header">
        <h2 class="panel-title">巡检结果</h2>
        <button id="batch-to-notify">带入通知预览</button>
      </div>
      <div class="auto-summary">
        ${summaryItem("检查卡片", result.checkedCardCount)}
        ${summaryItem("异常数量", result.anomalyCount)}
        ${summaryItem("看板数量", result.dashboardCount)}
        ${summaryItem("巡检时间", formatDisplayTime(result.checkedAt))}
      </div>
      ${anomalies.length ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>国家</th>
                <th>看板</th>
                <th>卡片</th>
                <th>类型</th>
                <th>消息</th>
              </tr>
            </thead>
            <tbody>
              ${anomalies.slice(0, 80).map((anomaly) => `
                <tr>
                  <td>${escapeHtml([anomaly.countryName, anomaly.countryCode].filter(Boolean).join(" / ") || "-")}</td>
                  <td>${escapeHtml(anomaly.dashboardTitle || "-")}</td>
                  <td>${escapeHtml(anomaly.cardTitle || "-")}</td>
                  <td>${escapeHtml(ruleTypeLabel(anomaly.type))}</td>
                  <td>${escapeHtml(anomaly.message || "-")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
        ${anomalies.length > 80 ? `<p class="muted">仅展示前 80 条异常，共 ${anomalies.length} 条。</p>` : ""}
      ` : `<p class="success">本次范围内没有规则异常。</p>`}
      <details class="advanced compact">
        <summary>查看本次巡检 result JSON</summary>
        <pre class="code">${escapeHtml(json(result))}</pre>
      </details>
    </section>
  `;
}

function buildNotifyDraftFromBatch(result) {
  return {
    sourceLabel: "来自批量真实只读巡检",
    checkedAt: result.checkedAt || new Date().toISOString(),
    checkedCardCount: result.checkedCardCount || 0,
    dataQualityAnomalyCount: result.dataQualityAnomalyCount || 0,
    maxAnomalies: state.notifyDraft?.maxAnomalies || 50,
    webhookUrl: state.notifyDraft?.webhookUrl || "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    mentions: state.notifyDraft?.mentions || "",
    botId: state.notifyDraft?.botId || defaultBotId(),
    anomalies: result.anomalies || [],
  };
}

function summaryItem(label, value) {
  return `
    <div class="info-item">
      <span>${label}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
  `;
}

function defaultBotId() {
  return state.rulesConfig?.alerts?.botId && state.rulesConfig.alerts.botId !== "<hidden>"
    ? state.rulesConfig.alerts.botId
    : "";
}

function formatDisplayTime(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) {
    return value || "-";
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

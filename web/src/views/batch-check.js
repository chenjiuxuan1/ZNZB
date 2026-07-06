import { apiPost } from "../api.js";
import { setRoute, state } from "../state.js";
import { countryLabel, escapeHtml, json, ruleTypeLabel } from "../view-utils.js";

const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";

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
      <h2 class="panel-title">巡检范围</h2>
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
      <h2 class="panel-title section-title">通知配置</h2>
      <div class="form-grid">
        <div class="field">
          <label>TV webhook 地址</label>
          <input id="batch-webhook-url" value="${escapeHtml(getBatchNotifyConfig().webhookUrl)}" placeholder="${escapeHtml(DEFAULT_TV_WEBHOOK_URL)}">
        </div>
        <div class="field">
          <label>TV bot_id</label>
          <input id="batch-bot-id" value="${escapeHtml(getBatchNotifyConfig().botId)}" placeholder="必填：用于后续通知预览和测试发送">
        </div>
        <div class="field wide-form-field">
          <label>提醒人 mentions</label>
          <input id="batch-mentions" value="${escapeHtml(getBatchNotifyConfig().mentions)}" placeholder="可选：邮箱，多个用逗号或换行分隔">
        </div>
      </div>
      <p class="muted">真实巡检只读取 Metabase 并生成结果，不会自动发送 TV；这里的发送配置会随结果带入“通知预览”，确认文案后再手动发送。</p>
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
  root.querySelector("#batch-webhook-url")?.addEventListener("input", () => updateBatchNotifyConfigFromDom(root));
  root.querySelector("#batch-bot-id")?.addEventListener("input", () => updateBatchNotifyConfigFromDom(root));
  root.querySelector("#batch-mentions")?.addEventListener("input", () => updateBatchNotifyConfigFromDom(root));
  root.querySelector("#run-batch-check")?.addEventListener("click", async () => {
    updateBatchNotifyConfigFromDom(root);
    const validationError = validateBatchNotifyConfig();
    if (validationError) {
      state.batchCheckStatus = {
        type: "error",
        title: "请先补全真实巡检配置",
        detail: validationError,
      };
      state.batchCheckError = validationError;
      renderBatchCheck(root);
      return;
    }
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
        detail: `检查 ${state.batchCheckResult.checkedCardCount || 0} 张卡片，发现 ${state.batchCheckResult.anomalyCount || 0} 条异常。通知配置已随结果准备好，可带入通知预览确认发送。`,
      };
      state.notifyDraft = buildNotifyDraftFromBatch(state.batchCheckResult);
      state.notifyPreview = null;
      state.notifyError = "";
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

function getBatchNotifyConfig() {
  if (!state.batchNotifyConfig) {
    state.batchNotifyConfig = {
      webhookUrl: DEFAULT_TV_WEBHOOK_URL,
      botId: defaultBotId(),
      mentions: "",
    };
  }
  if (!state.batchNotifyConfig.webhookUrl) {
    state.batchNotifyConfig.webhookUrl = DEFAULT_TV_WEBHOOK_URL;
  }
  if (!state.batchNotifyConfig.botId) {
    state.batchNotifyConfig.botId = defaultBotId();
  }
  return state.batchNotifyConfig;
}

function updateBatchNotifyConfigFromDom(root) {
  const config = getBatchNotifyConfig();
  config.webhookUrl = root.querySelector("#batch-webhook-url")?.value.trim() || "";
  config.botId = root.querySelector("#batch-bot-id")?.value.trim() || "";
  config.mentions = root.querySelector("#batch-mentions")?.value.trim() || "";
}

function validateBatchNotifyConfig() {
  const config = getBatchNotifyConfig();
  if (!config.webhookUrl) {
    return "TV webhook 地址不能为空。默认可使用 https://tv-service-alert.kuainiu.chat/alert/v2/array。";
  }
  if (!config.botId) {
    return "TV bot_id 不能为空。请先填写本次巡检结果后续要发送到的 TV bot_id。";
  }
  return "";
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
  const notifyConfig = getBatchNotifyConfig();
  return {
    sourceLabel: "来自批量真实只读巡检",
    checkedAt: result.checkedAt || new Date().toISOString(),
    checkedCardCount: result.checkedCardCount || 0,
    dataQualityAnomalyCount: result.dataQualityAnomalyCount || 0,
    maxAnomalies: state.notifyDraft?.maxAnomalies || 50,
    webhookUrl: notifyConfig.webhookUrl || DEFAULT_TV_WEBHOOK_URL,
    mentions: notifyConfig.mentions || "",
    botId: notifyConfig.botId || defaultBotId(),
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

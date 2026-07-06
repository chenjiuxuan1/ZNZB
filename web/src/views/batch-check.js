import { apiPost } from "../api.js";
import { state } from "../state.js";
import { countryLabel, escapeHtml, json, ruleTypeLabel } from "../view-utils.js";

const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";
const ALL_COUNTRIES = "__all__";

export function renderBatchCheck(root) {
  const countries = state.countries?.countries || [];
  const dashboards = state.inventory?.dashboards || [];
  const selectedCountry = state.selected.countryCode || countries[0]?.code || "";
  const isAllCountries = selectedCountry === ALL_COUNTRIES;
  const countryDashboards = dashboards.filter((dashboard) => {
    const code = dashboard.countryCode || dashboard.country?.code || "";
    return isAllCountries || !selectedCountry || code === selectedCountry;
  });
  const selectedDashboard = countryDashboards.find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || null;
  const selectedCardCount = countSelectedCards(countryDashboards, selectedDashboard);
  const result = state.batchCheckResult;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">批量巡检</h1>
        <p class="page-note">按国家或单个看板批量真实只读访问 Metabase，执行当前规则并直接发送 TV 通知；只读访问，不修改看板。</p>
      </div>
      <div class="button-group">
        <button class="primary" id="run-batch-check">开始巡检并发送 TV</button>
      </div>
    </div>
    <div class="notice">
      <strong>巡检范围</strong>
      <span>卡片数会按当前国家和看板范围自动计算；选择“全部国家 + 该范围全部看板”即可一次巡检所有看板。</span>
    </div>
    <section class="panel batch-controls">
      <h2 class="panel-title">巡检范围</h2>
      <div class="toolbar wide-toolbar">
        <label>
          国家
          <select id="batch-country">
            <option value="${ALL_COUNTRIES}" ${isAllCountries ? "selected" : ""}>全部国家</option>
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
          本次巡检卡片数
          <input id="batch-card-count" value="${escapeHtml(selectedCardCount)}" readonly>
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
          <input id="batch-bot-id" value="${escapeHtml(getBatchNotifyConfig().botId)}" placeholder="必填：用于接收本次巡检通知">
        </div>
        <div class="field wide-form-field">
          <label>提醒人 mentions</label>
          <input id="batch-mentions" value="${escapeHtml(getBatchNotifyConfig().mentions)}" placeholder="可选：邮箱，多个用逗号或换行分隔">
        </div>
      </div>
      <p class="muted">点击开始后会先只读访问 Metabase；只有发现异常才会把本次巡检汇总和异常明细发送到上方 TV bot_id，健康结果不会发送 TV。</p>
      ${renderBatchStatus()}
    </section>
    ${result ? renderBatchResult(result) : `<p class="muted">选择范围并确认通知配置后，点击“开始巡检并发送 TV”。</p>`}
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
      title: "正在巡检并发送 TV",
      detail: "正在只读访问 Metabase public dashcard JSON、执行规则并生成 TV 通知，请稍等。",
    };
    state.batchCheckError = "";
    state.batchCheckResult = null;
    renderBatchCheck(root);
    try {
      state.batchCheckResult = await apiPost("/api/batch-check-and-notify", {
        countryCode: isAllCountries ? "" : state.selected.countryCode || selectedCountry,
        dashboardUuid: state.selected.dashboardUuid || "",
        webhookUrl: getBatchNotifyConfig().webhookUrl,
        botId: getBatchNotifyConfig().botId,
        mentions: getBatchNotifyConfig().mentions,
      });
      const notification = state.batchCheckResult.notification || {};
      const sentText = notification.sent
        ? `已向 ${notification.botId || "TV bot"} 发送 ${notification.sentMessages || 0} 条消息。`
        : "本次没有异常，已跳过 TV 发送。";
      state.batchCheckStatus = {
        type: "success",
        title: notification.sent ? "批量巡检完成，TV 通知已发送" : "批量巡检完成，无需发送 TV",
        detail: `检查 ${state.batchCheckResult.checkedCardCount || 0} 张卡片，发现 ${state.batchCheckResult.anomalyCount || 0} 条异常；${sentText}`,
      };
    } catch (error) {
      state.batchCheckResult = null;
      state.batchCheckError = error.payload?.errors?.join("\n") || error.message;
      state.batchCheckStatus = {
        type: "error",
        title: "批量巡检或 TV 发送失败",
        detail: "请检查看板 public 链接、网络可达性、规则配置或 TV webhook/bot_id。",
      };
    }
    renderBatchCheck(root);
  });
}

function clearBatchFeedback() {
  state.batchCheckResult = null;
  state.batchCheckStatus = null;
  state.batchCheckError = "";
}

function countSelectedCards(countryDashboards, selectedDashboard) {
  if (selectedDashboard) {
    return selectedDashboard.cards?.length || 0;
  }
  return countryDashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0);
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
  const notification = result.notification || {};
  return `
    <section class="panel">
      <div class="detail-header compact-header">
        <h2 class="panel-title">巡检结果</h2>
      </div>
      <div class="auto-summary">
        ${summaryItem("检查卡片", result.checkedCardCount)}
        ${summaryItem("异常数量", result.anomalyCount)}
        ${summaryItem("看板数量", result.dashboardCount)}
        ${summaryItem("巡检时间", formatDisplayTime(result.checkedAt))}
      </div>
      ${renderNotificationResult(notification)}
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

function renderNotificationResult(notification) {
  if (notification.skipped) {
    return `
      <div class="sandbox-status idle">
        <strong>TV 通知未发送</strong>
        <span>本次范围内没有规则异常，按配置跳过健康通知。</span>
      </div>
    `;
  }
  if (!notification.sentMessages) {
    return "";
  }
  const mentions = Array.isArray(notification.mentions) && notification.mentions.length
    ? notification.mentions.join(", ")
    : "无";
  return `
    <div class="sandbox-status success">
      <strong>TV 通知已发送</strong>
      <span>bot_id：${escapeHtml(notification.botId || "-")}；消息数：${escapeHtml(notification.sentMessages)}；提醒人：${escapeHtml(mentions)}</span>
    </div>
  `;
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

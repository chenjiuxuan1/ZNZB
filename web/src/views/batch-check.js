import { apiPost, apiPut } from "../api.js";
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
      <span>“该国家告警巡检看板”指当前配置清单里的公共看板范围，不是 Metabase 空间里的全部看板；选择单个看板时只巡检该看板内的卡片。</span>
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
            <option value="">该国家告警巡检看板</option>
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
      ${renderBatchSchedulePanel()}
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
  root.querySelector("#save-batch-schedule")?.addEventListener("click", async () => {
    updateBatchNotifyConfigFromDom(root);
    const payload = buildBatchSchedulePayload(root, {
      countryCode: isAllCountries ? "" : state.selected.countryCode || selectedCountry,
      dashboardUuid: state.selected.dashboardUuid || "",
    });
    state.batchScheduleStatus = {
      type: "loading",
      title: "正在保存定时巡检",
      detail: "保存后服务会每分钟检查一次，到期自动执行当前范围的巡检。",
    };
    state.batchScheduleError = "";
    renderBatchCheck(root);
    try {
      state.batchSchedule = await apiPut("/api/batch-schedule", payload);
      state.batchScheduleStatus = {
        type: "success",
        title: state.batchSchedule.enabled ? "定时巡检已启用" : "定时巡检已关闭",
        detail: state.batchSchedule.enabled
          ? `下次运行：${formatDisplayTime(state.batchSchedule.nextRunAt)}；间隔 ${state.batchSchedule.intervalMinutes} 分钟。`
          : "已保存为关闭状态，后续不会自动触发。",
      };
    } catch (error) {
      state.batchScheduleError = error.payload?.errors?.join("\n") || error.message;
      state.batchScheduleStatus = {
        type: "error",
        title: "定时巡检保存失败",
        detail: "请检查 TV webhook、bot_id 和巡检间隔配置。",
      };
    }
    renderBatchCheck(root);
  });
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

function renderBatchSchedulePanel() {
  const schedule = state.batchSchedule || {};
  const enabled = Boolean(schedule.enabled);
  const status = state.batchScheduleStatus;
  return `
    <div class="sub-panel schedule-panel">
      <h2 class="panel-title section-title">定时巡检</h2>
      <div class="form-grid">
        <label class="checkbox-field">
          <input id="batch-schedule-enabled" type="checkbox" ${enabled ? "checked" : ""}>
          <span>启用服务内定时巡检</span>
        </label>
        <div class="field">
          <label>巡检间隔（分钟）</label>
          <input id="batch-schedule-interval" type="number" min="5" max="1440" step="5" value="${escapeHtml(schedule.intervalMinutes || 120)}">
        </div>
        <div class="field">
          <label>下次运行</label>
          <input value="${escapeHtml(formatDisplayTime(schedule.nextRunAt))}" readonly>
        </div>
        <div class="field">
          <label>上次运行</label>
          <input value="${escapeHtml(formatDisplayTime(schedule.lastRunAt))}" readonly>
        </div>
      </div>
      <p class="muted">定时任务按国家分别巡检。每个国家可以单独启用，并配置自己的看板范围、bot_id 和提醒人；不选择具体看板时默认扫描该国家告警巡检看板。</p>
      ${renderCountryScheduleConfig(schedule)}
      ${schedule.lastResult ? renderScheduleLastResult(schedule.lastResult) : ""}
      ${schedule.lastError ? `<div class="sandbox-status error"><strong>上次定时运行失败</strong><span>${escapeHtml(schedule.lastError)}</span></div>` : ""}
      ${renderBatchScheduleStatus(status)}
      <div class="button-group">
        <button id="save-batch-schedule" class="secondary">保存定时巡检</button>
      </div>
    </div>
  `;
}

function renderScheduleLastResult(result) {
  if (Array.isArray(result.runs)) {
    return `
      <div class="sandbox-status idle">
        <strong>上次定时结果</strong>
        <span>国家 ${escapeHtml(result.countryCount || 0)} 个，成功 ${escapeHtml(result.successCount || 0)} 个，失败 ${escapeHtml(result.failedCount || 0)} 个；检查 ${escapeHtml(result.checkedCardCount || 0)} 张卡片，异常 ${escapeHtml(result.anomalyCount || 0)} 条。</span>
      </div>
    `;
  }
  const notification = result.notification || {};
  const notifyText = notification.sent
    ? `已发送 ${notification.sentMessages || 0} 条 TV 消息`
    : notification.skipped
      ? "无异常，跳过 TV"
      : "未发送 TV";
  return `
    <div class="sandbox-status idle">
      <strong>上次定时结果</strong>
      <span>检查 ${escapeHtml(result.checkedCardCount || 0)} 张卡片，异常 ${escapeHtml(result.anomalyCount || 0)} 条；${escapeHtml(notifyText)}。</span>
    </div>
  `;
}

function renderCountryScheduleConfig(schedule) {
  const countries = state.countries?.countries || [];
  const dashboards = state.inventory?.dashboards || [];
  const configs = new Map((schedule.countryConfigs || []).map((item) => [item.countryCode, item]));
  return `
    <div class="table-wrap schedule-table">
      <table>
        <thead>
          <tr>
            <th>启用</th>
            <th>国家</th>
            <th>看板范围</th>
            <th>TV bot_id</th>
            <th>提醒人 mentions</th>
          </tr>
        </thead>
        <tbody>
          ${countries.map((country) => {
            const config = configs.get(country.code) || {};
            const countryDashboards = dashboards.filter((dashboard) => {
              const code = dashboard.countryCode || dashboard.country?.code || "";
              return code === country.code;
            });
            const selectedDashboardUuid = Array.isArray(config.dashboardUuids) ? config.dashboardUuids[0] || "" : "";
            return `
              <tr class="schedule-country-row" data-country-code="${escapeHtml(country.code || "")}">
                <td><input class="schedule-country-enabled" type="checkbox" ${config.enabled ? "checked" : ""}></td>
                <td>${escapeHtml(countryLabel(country, countries))}</td>
                <td>
                  <select class="schedule-country-dashboard-uuid">
                    <option value="" ${selectedDashboardUuid ? "" : "selected"}>该国家告警巡检看板</option>
                    ${countryDashboards.map((dashboard) => `<option value="${escapeHtml(dashboard.uuid || "")}" ${selectedDashboardUuid === dashboard.uuid ? "selected" : ""}>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "")}</option>`).join("")}
                  </select>
                </td>
                <td><input class="schedule-country-bot-id" value="${escapeHtml(config.botId || "")}" placeholder="该国家接收 bot_id"></td>
                <td><input class="schedule-country-mentions" value="${escapeHtml(config.mentions || "")}" placeholder="邮箱，多个用逗号分隔"></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderBatchScheduleStatus(status) {
  if (!status) {
    return "";
  }
  if (status.type === "error") {
    return `
      <div class="sandbox-status error">
        <strong>${escapeHtml(status.title)}</strong>
        <span>${escapeHtml(status.detail || "")}</span>
        <pre>${escapeHtml(state.batchScheduleError || "-")}</pre>
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

function buildBatchSchedulePayload(root, scope) {
  return {
    enabled: Boolean(root.querySelector("#batch-schedule-enabled")?.checked),
    intervalMinutes: Number(root.querySelector("#batch-schedule-interval")?.value || 120),
    countryCode: scope.countryCode || "",
    dashboardUuid: scope.dashboardUuid || "",
    webhookUrl: getBatchNotifyConfig().webhookUrl,
    botId: getBatchNotifyConfig().botId,
    mentions: getBatchNotifyConfig().mentions,
    countryConfigs: [...root.querySelectorAll(".schedule-country-row")].map((row) => ({
      countryCode: row.dataset.countryCode || "",
      enabled: Boolean(row.querySelector(".schedule-country-enabled")?.checked),
      dashboardUuids: [row.querySelector(".schedule-country-dashboard-uuid")?.value || ""].filter(Boolean),
      webhookUrl: getBatchNotifyConfig().webhookUrl,
      botId: row.querySelector(".schedule-country-bot-id")?.value.trim() || "",
      mentions: row.querySelector(".schedule-country-mentions")?.value.trim() || "",
    })),
  };
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
      ${renderDashboardScanDetails(result)}
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

function renderDashboardScanDetails(result) {
  const dashboardRows = buildDashboardScanRows(result);
  if (!dashboardRows.length) {
    return "";
  }
  return `
    <div class="sub-panel dashboard-scan-details">
      <h2 class="panel-title">看板扫描明细</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>国家</th>
              <th>看板</th>
              <th>检查卡片</th>
              <th>查询失败</th>
              <th>异常数量</th>
              <th>状态</th>
              <th>已扫描卡片示例</th>
            </tr>
          </thead>
          <tbody>
            ${dashboardRows.map((row) => `
              <tr>
                <td>${escapeHtml([row.countryName, row.countryCode].filter(Boolean).join(" / ") || "-")}</td>
                <td>${escapeHtml(row.dashboardTitle || "-")}</td>
                <td>${escapeHtml(row.checkedCardCount)}</td>
                <td>${escapeHtml(row.failedCardCount)}</td>
                <td>${escapeHtml(row.anomalyCount)}</td>
                <td><span class="badge ${escapeHtml(row.badgeClass)}">${escapeHtml(row.statusText)}</span></td>
                <td>${escapeHtml(row.cardPreview || "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function buildDashboardScanRows(result) {
  const groups = new Map();
  for (const card of result.checkedCards || []) {
    const key = `${card.countryCode || ""}::${card.dashboardUuid || card.dashboardTitle || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: card.countryCode || "",
        countryName: card.countryName || "",
        dashboardTitle: card.dashboardTitle || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
        cards: [],
      });
    }
    const group = groups.get(key);
    group.checkedCardCount += 1;
    if (!card.ok) {
      group.failedCardCount += 1;
    }
    if (card.cardTitle && group.cards.length < 5) {
      group.cards.push(card.cardTitle);
    }
  }
  for (const anomaly of result.anomalies || []) {
    const key = `${anomaly.countryCode || ""}::${anomaly.dashboardUuid || anomaly.dashboardTitle || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: anomaly.countryCode || "",
        countryName: anomaly.countryName || "",
        dashboardTitle: anomaly.dashboardTitle || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
        cards: [],
      });
    }
    groups.get(key).anomalyCount += 1;
  }
  return [...groups.values()].map((group) => {
    const statusText = group.anomalyCount > 0
      ? "有异常"
      : group.failedCardCount > 0
        ? "查询失败"
        : "正常";
    const badgeClass = group.anomalyCount > 0 || group.failedCardCount > 0 ? "warn" : "ok";
    return {
      ...group,
      statusText,
      badgeClass,
      cardPreview: group.cards.join("、"),
    };
  });
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

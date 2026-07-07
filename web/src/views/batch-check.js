import { apiGet, apiPost, apiPut } from "../api.js";
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
  root.querySelectorAll(".schedule-country-notify-channel").forEach((select) => {
    select.addEventListener("change", (event) => {
      const row = event.target.closest(".schedule-country-row");
      if (row) {
        row.dataset.notifyChannel = event.target.value || "knBot";
      }
    });
  });
  root.querySelectorAll(".schedule-country-enabled").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const row = event.target.closest(".schedule-country-row");
      updateScheduleCountryRowState(row, event.target.checked);
    });
  });
  root.querySelector("#batch-history-country")?.addEventListener("change", async (event) => {
    state.batchHistoryFilters.countryCode = event.target.value;
    await reloadBatchHistory(root);
  });
  root.querySelector("#batch-history-status")?.addEventListener("change", async (event) => {
    state.batchHistoryFilters.status = event.target.value;
    await reloadBatchHistory(root);
  });
  root.querySelector("#refresh-batch-history")?.addEventListener("click", async () => {
    await reloadBatchHistory(root);
  });
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
        title: state.batchSchedule.enabled ? "定时巡检已上线" : "定时巡检已下线",
        detail: state.batchSchedule.enabled
          ? `每日 ${formatDailyRunTimes(state.batchSchedule)} 北京时间运行；下次运行：${formatDisplayTime(state.batchSchedule.nextRunAt)}。`
          : "已保存为下线状态，后续不会自动触发。",
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
  root.querySelector("#run-batch-schedule-now")?.addEventListener("click", async () => {
    updateBatchNotifyConfigFromDom(root);
    const payload = buildBatchSchedulePayload(root, {
      countryCode: isAllCountries ? "" : state.selected.countryCode || selectedCountry,
      dashboardUuid: state.selected.dashboardUuid || "",
    });
    state.batchScheduleStatus = {
        type: "loading",
        title: "正在保存并立即试跑",
        detail: "会先保存当前定时配置，再按已上线国家逐个巡检；发现异常时会按各国家通知方式发送。",
    };
    state.batchScheduleError = "";
    renderBatchCheck(root);
    try {
      state.batchSchedule = await apiPut("/api/batch-schedule", payload);
      const result = await apiPost("/api/batch-schedule/run-now", {});
      state.batchSchedule = result.schedule || state.batchSchedule;
      const summary = result.result || {};
      state.batchScheduleStatus = {
        type: summary.failedCount > 0 ? "error" : "success",
        title: summary.failedCount > 0 ? "定时巡检测试完成，部分国家失败" : "定时巡检测试完成",
        detail: `国家 ${summary.countryCount || 0} 个，成功 ${summary.successCount || 0} 个，失败 ${summary.failedCount || 0} 个；检查 ${summary.checkedCardCount || 0} 张卡片，异常 ${summary.anomalyCount || 0} 条。`,
      };
      await reloadBatchHistory(root);
      return;
    } catch (error) {
      state.batchScheduleError = error.payload?.errors?.join("\n") || error.message;
      state.batchScheduleStatus = {
        type: "error",
        title: "定时巡检测试失败",
        detail: "请检查已启用国家、看板范围和通知接收目标。",
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

async function reloadBatchHistory(root) {
  const params = new URLSearchParams();
  if (state.batchHistoryFilters?.countryCode) {
    params.set("countryCode", state.batchHistoryFilters.countryCode);
  }
  if (state.batchHistoryFilters?.status) {
    params.set("status", state.batchHistoryFilters.status);
  }
  state.batchHistoryStatus = {
    type: "loading",
    title: "正在刷新定时巡检历史",
    detail: "按当前筛选条件读取最近的定时巡检记录。",
  };
  renderBatchCheck(root);
  try {
    state.batchHistory = await apiGet(`/api/batch-history${params.toString() ? `?${params}` : ""}`);
    state.batchHistoryStatus = null;
  } catch (error) {
    state.batchHistoryStatus = {
      type: "error",
      title: "定时巡检历史读取失败",
      detail: error.message,
    };
  }
  renderBatchCheck(root);
}

function renderBatchSchedulePanel() {
  const schedule = state.batchSchedule || {};
  const enabled = Boolean(schedule.enabled);
  const status = state.batchScheduleStatus;
  return `
    <div class="sub-panel schedule-panel">
      <h2 class="panel-title section-title">定时巡检</h2>
      ${renderScheduleOverview(schedule)}
      <div class="form-grid">
        <label class="checkbox-field">
          <input id="batch-schedule-enabled" type="checkbox" ${enabled ? "checked" : ""}>
          <span>自动触发总开关</span>
        </label>
        <div class="field wide-form-field">
          <label>每日运行时间（北京时间，可多个）</label>
          <input id="batch-schedule-daily-run-times" value="${escapeHtml(formatDailyRunTimes(schedule))}" placeholder="例如：09:00, 14:30, 20:00">
          <small class="muted">多个时间用逗号、空格或换行分隔；服务每天会在这些北京时间点各运行一次。</small>
        </div>
        <div class="field">
          <label>下次运行</label>
          <input value="${escapeHtml(schedule.enabled ? formatDisplayTime(schedule.nextRunAt) : "未启用")}" readonly>
        </div>
        <div class="field">
          <label>上次运行</label>
          <input value="${escapeHtml(formatDisplayTime(schedule.lastRunAt))}" readonly>
        </div>
      </div>
      <p class="muted">“自动触发总开关”控制服务是否到点自动跑定时巡检：关闭后所有国家都不会自动触发，但仍可点击“立即运行测试”。取消某个国家的勾选并保存，只会下线该国家。</p>
      <div class="schedule-help">
        <strong>KN Chat 接收目标说明</strong>
        <span>选择 KN Chat 机器人时，只填写接收人邮箱即可，服务会先调用 resolveUserId 把邮箱解析为 user_id，再私聊发送；多个邮箱用逗号分隔。选择 TV webhook 时，才需要填写 TV bot_id 和提醒人 mentions。</span>
      </div>
      ${renderCountryScheduleConfig(schedule)}
      ${schedule.lastResult ? renderScheduleLastResult(schedule.lastResult) : ""}
      ${schedule.lastError ? `<div class="sandbox-status error"><strong>上次定时运行失败</strong><span>${escapeHtml(schedule.lastError)}</span></div>` : ""}
      ${renderBatchScheduleStatus(status)}
      <div class="button-group">
        <button id="save-batch-schedule" class="secondary">保存定时巡检</button>
        <button id="run-batch-schedule-now" class="primary">立即运行测试</button>
      </div>
      ${renderBatchHistoryPanel()}
    </div>
  `;
}

function renderScheduleOverview(schedule) {
  const configs = schedule.countryConfigs || [];
  const enabledCountries = configs.filter((item) => item.enabled);
  const totalCountries = (state.countries?.countries || []).length || configs.length;
  return `
    <div class="schedule-overview">
      <div class="info-item">
        <span>总开关</span>
        <strong><span class="badge ${schedule.enabled ? "ok" : "danger"}">${schedule.enabled ? "已开启" : "已关闭"}</span></strong>
      </div>
      <div class="info-item">
        <span>已上线国家</span>
        <strong>${escapeHtml(enabledCountries.length)} / ${escapeHtml(totalCountries)}</strong>
      </div>
      <div class="info-item">
        <span>下次运行</span>
        <strong>${escapeHtml(schedule.enabled ? formatDisplayTime(schedule.nextRunAt) : "未启用")}</strong>
      </div>
      <div class="info-item">
        <span>每日定点</span>
        <strong>${escapeHtml(formatDailyRunTimes(schedule))} 北京时间</strong>
      </div>
      <div class="info-item">
        <span>上次运行</span>
        <strong>${escapeHtml(formatDisplayTime(schedule.lastRunAt))}</strong>
      </div>
    </div>
  `;
}

function renderBatchHistoryPanel() {
  const countries = state.countries?.countries || [];
  const filters = state.batchHistoryFilters || {};
  const history = state.batchHistory || { runs: [] };
  const runs = history.runs || [];
  return `
    <div class="sub-panel schedule-history-panel">
      <div class="detail-header compact-header">
        <h2 class="panel-title">定时巡检历史</h2>
        <button id="refresh-batch-history" class="ghost">刷新历史</button>
      </div>
      <div class="toolbar wide-toolbar">
        <label>
          国家
          <select id="batch-history-country">
            <option value="">全部国家</option>
            ${countries.map((country) => `<option value="${escapeHtml(country.code || "")}" ${filters.countryCode === country.code ? "selected" : ""}>${escapeHtml(countryLabel(country, countries))}</option>`).join("")}
          </select>
        </label>
        <label>
          状态
          <select id="batch-history-status">
            <option value="" ${filters.status ? "" : "selected"}>全部状态</option>
            <option value="anomaly" ${filters.status === "anomaly" ? "selected" : ""}>有异常</option>
            <option value="healthy" ${filters.status === "healthy" ? "selected" : ""}>无异常</option>
            <option value="success" ${filters.status === "success" ? "selected" : ""}>运行成功</option>
            <option value="partial_failed" ${filters.status === "partial_failed" ? "selected" : ""}>部分失败</option>
            <option value="failed" ${filters.status === "failed" ? "selected" : ""}>运行失败</option>
          </select>
        </label>
      </div>
      ${renderBatchHistoryStatus()}
      ${runs.length ? renderBatchHistoryRows(runs) : `<p class="muted">暂无定时巡检历史。保存并启用定时巡检后，每次到期执行都会在这里留一条记录。</p>`}
    </div>
  `;
}

function renderBatchHistoryStatus() {
  const status = state.batchHistoryStatus;
  if (!status) {
    return "";
  }
  return `
    <div class="sandbox-status ${escapeHtml(status.type)}">
      <strong>${escapeHtml(status.title)}</strong>
      <span>${escapeHtml(status.detail || "")}</span>
    </div>
  `;
}

function renderBatchHistoryRows(runs) {
  return `
    <div class="table-wrap schedule-history-table">
      <table>
        <thead>
          <tr>
            <th>运行时间</th>
            <th>状态</th>
            <th>国家</th>
            <th>看板/卡片</th>
            <th>异常</th>
            <th>通知</th>
            <th>明细</th>
          </tr>
        </thead>
        <tbody>
          ${runs.map((run) => `
            <tr>
              <td>${escapeHtml(formatDisplayTime(run.startedAt))}</td>
              <td><span class="badge ${escapeHtml(historyBadgeClass(run))}">${escapeHtml(historyStatusText(run))}</span></td>
              <td>${escapeHtml(formatHistoryCountries(run))}</td>
              <td>${escapeHtml(run.dashboardCount || 0)} 个看板 / ${escapeHtml(run.checkedCardCount || 0)} 张卡片</td>
              <td>${escapeHtml((run.anomalyCount || 0) + (run.dataQualityAnomalyCount || 0))}</td>
              <td>${escapeHtml(run.notificationSentCount || 0)} 条</td>
              <td>${renderHistoryRunDetails(run)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderHistoryRunDetails(run) {
  return `
    <details class="history-details">
      <summary>查看</summary>
      ${(run.runs || []).map((countryRun) => `
        <div class="history-country-run">
          <strong>${escapeHtml([countryRun.countryName, countryRun.countryCode].filter(Boolean).join(" / ") || "-")}</strong>
          ${countryRun.ok ? renderHistoryCountryResult(countryRun.result || {}) : `<p class="error">${escapeHtml(countryRun.error || "运行失败")}</p>`}
        </div>
      `).join("")}
    </details>
  `;
}

function renderHistoryCountryResult(result) {
  const dashboards = result.checkedDashboards || [];
  return `
    <p class="muted">检查 ${escapeHtml(result.checkedCardCount || 0)} 张卡片，异常 ${escapeHtml((result.anomalyCount || 0) + (result.dataQualityAnomalyCount || 0))} 条。</p>
    ${dashboards.length ? `
      <ul class="history-dashboard-list">
        ${dashboards.map((dashboard) => `
          <li>
            ${escapeHtml(dashboard.dashboardTitle || "-")}：
            ${escapeHtml(dashboard.checkedCardCount || 0)} 张卡片，
            ${escapeHtml(dashboard.failedCardCount || 0)} 查询失败，
            ${escapeHtml(dashboard.anomalyCount || 0)} 异常
          </li>
        `).join("")}
      </ul>
    ` : ""}
  `;
}

function historyStatusText(run) {
  if (run.status === "failed") return "失败";
  if (run.status === "partial_failed") return "部分失败";
  if ((run.anomalyCount || 0) + (run.dataQualityAnomalyCount || 0) > 0) return "有异常";
  return "正常";
}

function historyBadgeClass(run) {
  if (run.status === "failed" || run.status === "partial_failed") return "danger";
  return (run.anomalyCount || 0) + (run.dataQualityAnomalyCount || 0) > 0 ? "warn" : "ok";
}

function formatHistoryCountries(run) {
  return (run.runs || [])
    .map((item) => [item.countryName, item.countryCode].filter(Boolean).join(" / ") || item.countryCode)
    .filter(Boolean)
    .join("、") || "-";
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
            <th>状态</th>
            <th>国家</th>
            <th>看板范围</th>
            <th>通知方式</th>
            <th>接收目标</th>
            <th>提醒人</th>
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
            const notifyChannel = config.notifyChannel || "knBot";
            const rowEnabled = Boolean(config.enabled);
            return `
              <tr class="schedule-country-row" data-country-code="${escapeHtml(country.code || "")}" data-notify-channel="${escapeHtml(notifyChannel)}">
                <td><input class="schedule-country-enabled" type="checkbox" ${rowEnabled ? "checked" : ""}></td>
                <td><span class="badge schedule-country-state ${rowEnabled ? "ok" : "danger"}">${rowEnabled ? "已上线" : "未上线"}</span></td>
                <td>${escapeHtml(countryLabel(country, countries))}</td>
                <td>
                  <select class="schedule-country-dashboard-uuid">
                    <option value="" ${selectedDashboardUuid ? "" : "selected"}>该国家告警巡检看板</option>
                    ${countryDashboards.map((dashboard) => `<option value="${escapeHtml(dashboard.uuid || "")}" ${selectedDashboardUuid === dashboard.uuid ? "selected" : ""}>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "")}</option>`).join("")}
                  </select>
                </td>
                <td>
                  <select class="schedule-country-notify-channel">
                    <option value="knBot" ${notifyChannel === "knBot" ? "selected" : ""}>KN Chat 机器人</option>
                    <option value="tv" ${notifyChannel === "tv" ? "selected" : ""}>TV webhook</option>
                  </select>
                </td>
                <td>
                  <div class="stacked-fields">
                    <input class="schedule-country-recipient-emails kn-target-field" value="${escapeHtml(config.recipientEmails || "")}" placeholder="接收人邮箱，多个用逗号分隔">
                    <input class="schedule-country-bot-id tv-target-field" value="${escapeHtml(config.botId || "")}" placeholder="TV bot_id">
                  </div>
                </td>
                <td>
                  <input class="schedule-country-mentions tv-target-field" value="${escapeHtml(config.mentions || "")}" placeholder="TV 提醒人邮箱，多个用逗号分隔">
                  <span class="kn-target-field muted-inline">KN Chat 按邮箱私聊，无需填写提醒人</span>
                </td>
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
    dailyRunTimes: parseDailyRunTimes(root.querySelector("#batch-schedule-daily-run-times")?.value || "09:00"),
    intervalMinutes: 1440,
    countryCode: scope.countryCode || "",
    dashboardUuid: scope.dashboardUuid || "",
    webhookUrl: getBatchNotifyConfig().webhookUrl,
    botId: getBatchNotifyConfig().botId,
    mentions: getBatchNotifyConfig().mentions,
    countryConfigs: [...root.querySelectorAll(".schedule-country-row")].map((row) => {
      const notifyChannel = row.querySelector(".schedule-country-notify-channel")?.value || "knBot";
      return {
        countryCode: row.dataset.countryCode || "",
        enabled: Boolean(row.querySelector(".schedule-country-enabled")?.checked),
        dashboardUuids: [row.querySelector(".schedule-country-dashboard-uuid")?.value || ""].filter(Boolean),
        notifyChannel,
        webhookUrl: getBatchNotifyConfig().webhookUrl,
        botId: notifyChannel === "tv" ? row.querySelector(".schedule-country-bot-id")?.value.trim() || "" : "",
        botToken: notifyChannel === "knBot" ? "${KN_BOT_TOKEN}" : "",
        chatId: "",
        recipientEmails: notifyChannel === "knBot" ? row.querySelector(".schedule-country-recipient-emails")?.value.trim() || "" : "",
        mentions: notifyChannel === "tv" ? row.querySelector(".schedule-country-mentions")?.value.trim() || "" : "",
      };
    }),
  };
}

function updateScheduleCountryRowState(row, enabled) {
  if (!row) {
    return;
  }
  const badge = row.querySelector(".schedule-country-state");
  if (!badge) {
    return;
  }
  badge.textContent = enabled ? "已上线" : "未上线";
  badge.classList.toggle("ok", enabled);
  badge.classList.toggle("danger", !enabled);
}

function parseDailyRunTimes(value) {
  const times = String(value || "")
    .split(/[\n,，;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
  return [...new Set(times)].sort();
}

function formatDailyRunTimes(schedule = {}) {
  const times = Array.isArray(schedule.dailyRunTimes) && schedule.dailyRunTimes.length
    ? schedule.dailyRunTimes
    : [schedule.dailyRunTime || "09:00"];
  return parseDailyRunTimes(times.join(",")).join(", ") || "09:00";
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
  if (!value) {
    return "-";
  }
  const date = new Date(value);
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

function formatDateTimeLocal(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const pad = (number) => String(number).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

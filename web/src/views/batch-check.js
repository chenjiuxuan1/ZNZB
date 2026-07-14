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
  const activeTab = state.routeQuery?.historyRunId
    ? "history"
    : state.batchCheckTab || "manual";

  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">Metabase 定时巡检</h1>
        <p class="page-note">只读访问 Metabase，按当前规则识别公共报表缺失和波动；手动巡检、定时任务和历史明细分区管理。</p>
      </div>
      ${renderBatchHeroStats()}
    </div>
    ${renderBatchWorkspaceTabs(activeTab)}
    ${state.routeQuery?.historyRunId ? renderSelectedHistoryRunDetail() : `
      ${activeTab === "manual" ? renderManualBatchCheckPanel({
        countries,
        countryDashboards,
        selectedCountry,
        isAllCountries,
        selectedDashboard,
        selectedCardCount,
        result,
      }) : ""}
      ${activeTab === "schedule" ? renderBatchSchedulePanel() : ""}
      ${activeTab === "history" ? renderBatchHistoryPanel() : ""}
    `}
  `;

  root.querySelectorAll("[data-batch-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.batchCheckTab = button.dataset.batchTab || "manual";
      if (state.routeQuery?.historyRunId) {
        state.routeQuery = {};
        window.history.replaceState(null, "", "#/batch-check");
      }
      clearBatchFeedback();
      renderBatchCheck(root);
    });
  });

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
      updateScheduleOverviewFromDom(root);
    });
  });
  root.querySelector("#batch-schedule-enabled")?.addEventListener("change", () => {
    updateScheduleOverviewFromDom(root);
  });
  root.querySelector("#batch-schedule-daily-run-times")?.addEventListener("input", (event) => {
    const preview = root.querySelector("#batch-schedule-time-preview");
    if (preview) {
      preview.innerHTML = renderTimeChips(parseDailyRunTimes(event.target.value));
    }
    updateScheduleOverviewFromDom(root);
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
    state.batchScheduleProgress = null;
    renderBatchCheck(root);
    try {
      state.batchSchedule = await apiPut("/api/batch-schedule", payload);
      startBatchScheduleProgressPolling(root);
      const result = await apiPost("/api/batch-schedule/run-now", {});
      state.batchSchedule = result.schedule || state.batchSchedule;
      await refreshBatchScheduleProgress();
      const summary = result.result || {};
      state.batchScheduleStatus = {
        type: summary.failedCount > 0 ? "error" : "success",
        title: summary.failedCount > 0 ? "定时巡检测试完成，部分国家失败" : "定时巡检测试完成",
        detail: `国家 ${summary.countryCount || 0} 个，成功 ${summary.successCount || 0} 个，失败 ${summary.failedCount || 0} 个；检查 ${summary.checkedCardCount || 0} 张卡片，异常 ${summary.anomalyCount || 0} 条。`,
      };
      stopBatchScheduleProgressPolling();
      await reloadBatchHistory(root);
      return;
    } catch (error) {
      stopBatchScheduleProgressPolling();
      await refreshBatchScheduleProgress().catch(() => {});
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
        title: notification.sent ? "Metabase 巡检完成，TV 通知已发送" : "Metabase 巡检完成，无需发送 TV",
        detail: `检查 ${state.batchCheckResult.checkedCardCount || 0} 张卡片，发现 ${state.batchCheckResult.anomalyCount || 0} 条异常；${sentText}`,
      };
    } catch (error) {
      state.batchCheckResult = null;
      state.batchCheckError = error.payload?.errors?.join("\n") || error.message;
      state.batchCheckStatus = {
        type: "error",
        title: "Metabase 巡检或 TV 发送失败",
        detail: "请检查看板 public 链接、网络可达性、规则配置或 TV webhook/bot_id。",
      };
    }
    renderBatchCheck(root);
  });
}

function renderBatchHeroStats() {
  const summary = state.summary || {};
  const schedule = state.batchSchedule || {};
  const historyRuns = state.batchHistory?.runs || [];
  const latestRun = historyRuns[0] || null;
  return `
    <div class="hero-stats" aria-label="Metabase 定时巡检概览">
      <article>
        <span>国家</span>
        <strong>${escapeHtml(summary.countryCount || 0)}</strong>
      </article>
      <article>
        <span>看板</span>
        <strong>${escapeHtml(summary.dashboardCount || 0)}</strong>
      </article>
      <article>
        <span>规则</span>
        <strong>${escapeHtml(summary.ruleCount || 0)}</strong>
      </article>
      <article>
        <span>定时</span>
        <strong>${schedule.enabled ? "已开启" : "未开启"}</strong>
      </article>
      <article>
        <span>最近运行</span>
        <strong>${escapeHtml(latestRun ? formatDisplayTime(latestRun.startedAt) : "-")}</strong>
      </article>
    </div>
  `;
}

function renderBatchWorkspaceTabs(activeTab) {
  const tabs = [
    { key: "manual", label: "手动巡检", detail: "一次性验证范围并通知", index: "01" },
    { key: "schedule", label: "定时任务", detail: "定点运行、按国家通知", index: "02" },
    { key: "history", label: "历史明细", detail: "查看每次运行细节", index: "03" },
  ];
  return `
    <div class="workspace-tabs" role="tablist">
      ${tabs.map((tab) => `
        <button class="${activeTab === tab.key ? "active" : ""}" data-batch-tab="${escapeHtml(tab.key)}" type="button">
          <small>${escapeHtml(tab.index)}</small>
          <strong>${escapeHtml(tab.label)}</strong>
          <span>${escapeHtml(tab.detail)}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderManualBatchCheckPanel({
  countries,
  countryDashboards,
  selectedCountry,
  isAllCountries,
  selectedDashboard,
  selectedCardCount,
  result,
}) {
  return `
    <section class="panel batch-controls">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">手动巡检</h2>
          <p class="muted">适合临时验证某个国家或单个看板；健康结果不会发通知，只有异常才发送。</p>
        </div>
        <button class="primary" id="run-batch-check">开始巡检并发送 TV</button>
      </div>
      <div class="notice compact-notice">
        <strong>范围说明</strong>
        <span>“该国家告警巡检看板”是配置清单里的公共看板范围，不是 Metabase 空间里的全部看板。</span>
      </div>
      <div class="manual-check-grid">
        <div class="sub-panel">
          <h2 class="panel-title">巡检范围</h2>
          <div class="manual-range-form">
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
        </div>
        <div class="sub-panel">
          <h2 class="panel-title">TV 通知</h2>
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
        </div>
      </div>
      ${renderBatchStatus()}
      ${result ? renderBatchResult(result) : `<p class="muted">选择范围并确认通知配置后，点击“开始巡检并发送 TV”。</p>`}
    </section>
  `;
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
    params.set("limit", "200");
    state.batchHistory = await apiGet(`/api/batch-history?${params}`);
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

async function refreshBatchScheduleProgress() {
  state.batchScheduleProgress = await apiGet("/api/batch-schedule/progress");
  return state.batchScheduleProgress;
}

function startBatchScheduleProgressPolling(root) {
  stopBatchScheduleProgressPolling();
  state.batchScheduleProgressTimer = window.setInterval(async () => {
    try {
      const progress = await refreshBatchScheduleProgress();
      renderBatchCheck(root);
      if (["success", "partial_failed", "failed"].includes(progress.status)) {
        stopBatchScheduleProgressPolling();
      }
    } catch {
      stopBatchScheduleProgressPolling();
    }
  }, 1000);
}

function stopBatchScheduleProgressPolling() {
  if (state.batchScheduleProgressTimer) {
    window.clearInterval(state.batchScheduleProgressTimer);
    state.batchScheduleProgressTimer = null;
  }
}

function renderBatchSchedulePanel() {
  const schedule = state.batchSchedule || {};
  const enabled = Boolean(schedule.enabled);
  const status = state.batchScheduleStatus;
  return `
    <section class="panel schedule-panel">
      <div class="schedule-title-row">
        <div>
          <h2 class="panel-title section-title">定时巡检</h2>
          <p class="muted">按国家配置自动巡检。总开关控制是否到点自动运行，国家开关控制该国家是否参与。</p>
        </div>
        <div class="button-group">
          <button id="save-batch-schedule" class="secondary">保存配置</button>
          <button id="run-batch-schedule-now" class="primary">立即运行测试</button>
        </div>
      </div>
      ${renderScheduleOverview(schedule)}
      ${renderScheduleRunProgress()}
      <div class="schedule-config-card">
        <label class="switch-field">
          <input id="batch-schedule-enabled" type="checkbox" ${enabled ? "checked" : ""}>
          <span class="switch-track"></span>
          <span>
            <strong>自动触发</strong>
            <small id="batch-schedule-enabled-copy">${enabled ? "已开启，到点会自动巡检已上线国家" : "已关闭，不会自动触发；仍可手动测试"}</small>
          </span>
        </label>
        <div class="field">
          <label>每日运行时间（北京时间，可多个）</label>
          <input id="batch-schedule-daily-run-times" value="${escapeHtml(formatDailyRunTimes(schedule))}" placeholder="例如：09:00, 14:30, 20:00">
          <div id="batch-schedule-time-preview" class="time-chip-row">${renderTimeChips(parseDailyRunTimes(formatDailyRunTimes(schedule)))}</div>
          <small class="muted">多个时间用逗号、空格或换行分隔；服务每天会在这些时间点各运行一次。</small>
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
      <div class="schedule-help">
        <strong>怎么下线</strong>
        <span>关闭“自动触发”并保存，会停止所有到点自动巡检；关闭某个国家卡片里的“上线”并保存，只会下线该国家。选择 KN Chat 机器人时只填接收人邮箱；选择 TV webhook 时填写 TV bot_id 和提醒人。</span>
      </div>
      ${renderCountryScheduleConfig(schedule)}
      ${schedule.lastResult ? renderScheduleLastResult(schedule.lastResult) : ""}
      ${schedule.lastError ? `<div class="sandbox-status error"><strong>上次定时运行失败</strong><span>${escapeHtml(schedule.lastError)}</span></div>` : ""}
      ${renderBatchScheduleStatus(status)}
    </section>
  `;
}

function renderScheduleOverview(schedule) {
  const configs = schedule.countryConfigs || [];
  const enabledCountries = configs.filter((item) => item.enabled);
  const totalCountries = (state.countries?.countries || []).length || configs.length;
  return `
    <div class="schedule-overview">
      <div class="info-item">
        <span>自动触发状态</span>
        <strong><span id="schedule-overview-enabled-badge" class="badge ${schedule.enabled ? "ok" : "danger"}">${schedule.enabled ? "已开启" : "已关闭"}</span></strong>
      </div>
      <div class="info-item">
        <span>已上线国家</span>
        <strong id="schedule-overview-country-count">${escapeHtml(enabledCountries.length)} / ${escapeHtml(totalCountries)}</strong>
      </div>
      <div class="info-item">
        <span>下次运行</span>
        <strong id="schedule-overview-next-run">${escapeHtml(schedule.enabled ? formatDisplayTime(schedule.nextRunAt) : "未启用")}</strong>
      </div>
      <div class="info-item">
        <span>每日定点</span>
        <strong id="schedule-overview-run-times">${escapeHtml(formatDailyRunTimes(schedule))} 北京时间</strong>
      </div>
      <div class="info-item">
        <span>上次运行</span>
        <strong>${escapeHtml(formatDisplayTime(schedule.lastRunAt))}</strong>
      </div>
    </div>
  `;
}

function renderScheduleRunProgress() {
  const progress = state.batchScheduleProgress;
  if (!progress || progress.status === "idle" || !(progress.countries || []).length) {
    return "";
  }
  const countries = progress.countries || [];
  const completed = Number(progress.completedCountries || 0);
  const total = Number(progress.totalCountries || countries.length || 0);
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const currentLabel = [progress.currentCountryName, progress.currentCountryCode].filter(Boolean).join(" / ");
  return `
    <div class="sub-panel schedule-progress-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">本次测试运行进度</h2>
          <p class="muted">${escapeHtml(formatScheduleProgressStatus(progress, currentLabel))}</p>
        </div>
        <span class="badge ${escapeHtml(scheduleProgressBadge(progress.status))}">${escapeHtml(scheduleProgressLabel(progress.status))}</span>
      </div>
      <div class="progress-track" aria-label="定时巡检测试进度">
        <span style="width:${escapeHtml(percent)}%"></span>
      </div>
      <div class="schedule-progress-list">
        ${countries.map((country) => `
          <article class="schedule-progress-item ${escapeHtml(country.status || "pending")}">
            <div>
              <strong>${escapeHtml([country.countryName, country.countryCode].filter(Boolean).join(" / ") || "-")}</strong>
              <span>${escapeHtml(scheduleCountryProgressSubtext(country))}</span>
            </div>
            <span class="badge ${escapeHtml(scheduleProgressBadge(country.status))}">${escapeHtml(scheduleProgressLabel(country.status))}</span>
          </article>
        `).join("")}
      </div>
    </div>
  `;
}

function formatScheduleProgressStatus(progress, currentLabel) {
  if (progress.status === "running") {
    return currentLabel
      ? `正在巡检 ${currentLabel}，已完成 ${progress.completedCountries || 0}/${progress.totalCountries || 0} 个国家。`
      : `正在准备巡检，已完成 ${progress.completedCountries || 0}/${progress.totalCountries || 0} 个国家。`;
  }
  if (progress.status === "sending") {
    return "国家巡检已完成，正在聚合汇总并发送通知。";
  }
  if (progress.status === "success") {
    return `测试运行完成，已完成 ${progress.completedCountries || 0}/${progress.totalCountries || 0} 个国家。`;
  }
  if (progress.status === "partial_failed") {
    return `测试运行完成，但有国家失败；已完成 ${progress.completedCountries || 0}/${progress.totalCountries || 0} 个国家。`;
  }
  if (progress.status === "failed") {
    return progress.error || "测试运行失败。";
  }
  return "等待开始。";
}

function scheduleCountryProgressSubtext(country) {
  if (country.status === "pending") {
    return "等待巡检";
  }
  if (country.status === "running") {
    return "正在读取 Metabase 并执行规则";
  }
  if (country.status === "failed") {
    return country.error || "运行失败";
  }
  if (country.status === "success") {
    return `检查 ${country.checkedCardCount || 0} 张卡片，异常 ${country.anomalyCount || 0} 条`;
  }
  return "";
}

function scheduleProgressLabel(status) {
  const labels = {
    pending: "等待",
    running: "运行中",
    sending: "发送中",
    success: "完成",
    partial_failed: "部分失败",
    failed: "失败",
  };
  return labels[status] || "未开始";
}

function scheduleProgressBadge(status) {
  if (status === "success") return "ok";
  if (status === "failed" || status === "partial_failed") return "danger";
  if (status === "running" || status === "sending") return "warn";
  return "idle";
}

function renderBatchHistoryPanel() {
  const countries = state.countries?.countries || [];
  const filters = state.batchHistoryFilters || {};
  const history = state.batchHistory || { runs: [] };
  const runs = history.runs || [];
  return `
    <section class="panel schedule-history-panel">
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
    </section>
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
              <td><a class="link-button" href="#/batch-check?historyRunId=${encodeURIComponent(run.id || "")}">打开详情页</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSelectedHistoryRunDetail() {
  const runId = state.routeQuery?.historyRunId || "";
  if (!runId) {
    return "";
  }
  const history = state.batchHistory || { runs: [] };
  const run = (history.runs || []).find((item) => String(item.id || "") === String(runId));
  if (!run) {
    return `
      <section class="panel history-detail-page">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">巡检历史详情</h2>
            <p class="muted">未找到这次巡检记录，可能本地历史已被清理。</p>
          </div>
          <a class="link-button" href="#/batch-check">返回 Metabase 定时巡检</a>
        </div>
      </section>
    `;
  }
  const selectedCountryCode = state.routeQuery?.countryCode || "";
  const countryRuns = selectedCountryCode
    ? (run.runs || []).filter((item) => item.countryCode === selectedCountryCode)
    : (run.runs || []);
  const titleSuffix = selectedCountryCode ? `（${escapeHtml(selectedCountryCode)}）` : "";
  return `
    <section class="panel history-detail-page" id="batch-history-detail">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">巡检历史详情${titleSuffix}</h2>
          <p class="muted">这里展示通知里没有展开的完整扫描结果：每个国家、每个看板检查了哪些卡片，哪些看板异常，具体异常消息是什么。</p>
        </div>
        <div class="button-group">
          <a class="link-button" href="#/batch-check">返回 Metabase 定时巡检</a>
        </div>
      </div>
      <div class="auto-summary">
        ${summaryItem("运行时间", formatDisplayTime(run.startedAt))}
        ${summaryItem("国家", `${run.successCount || 0}/${run.countryCount || 0}`)}
        ${summaryItem("检查卡片", run.checkedCardCount || 0)}
        ${summaryItem("异常数量", (run.anomalyCount || 0) + (run.dataQualityAnomalyCount || 0))}
      </div>
      ${renderHistoryCountryTabs(run, selectedCountryCode)}
      ${countryRuns.length ? countryRuns.map(renderHistoryCountryDetail).join("") : `<p class="muted">当前筛选国家没有这次巡检记录。</p>`}
      <details class="advanced compact">
        <summary>查看这次巡检完整 JSON</summary>
        <pre class="code">${escapeHtml(json(run))}</pre>
      </details>
    </section>
  `;
}

function renderHistoryCountryTabs(run, selectedCountryCode) {
  const countries = run.runs || [];
  if (countries.length <= 1) {
    return "";
  }
  return `
    <div class="history-country-tabs">
      <a class="country-pill ${selectedCountryCode ? "" : "active"}" href="#/batch-check?historyRunId=${encodeURIComponent(run.id || "")}">全部国家</a>
      ${countries.map((countryRun) => {
        const label = [countryRun.countryName, countryRun.countryCode].filter(Boolean).join(" / ") || "-";
        const active = selectedCountryCode === countryRun.countryCode;
        return `<a class="country-pill ${active ? "active" : ""}" href="#/batch-check?historyRunId=${encodeURIComponent(run.id || "")}&countryCode=${encodeURIComponent(countryRun.countryCode || "")}">${escapeHtml(label)}</a>`;
      }).join("")}
    </div>
  `;
}

function renderHistoryCountryDetail(countryRun) {
  const label = [countryRun.countryName, countryRun.countryCode].filter(Boolean).join(" / ") || "-";
  if (!countryRun.ok) {
    return `
      <div class="sub-panel history-country-detail">
        <h2 class="panel-title">${escapeHtml(label)}</h2>
        <div class="sandbox-status error">
          <strong>该国家巡检失败</strong>
          <span>${escapeHtml(countryRun.error || "运行失败")}</span>
        </div>
      </div>
    `;
  }
  const result = countryRun.result || {};
  const anomalies = result.anomalies || [];
  const hasDashboardAnomalySummary = Number(result.anomalyCount || 0) > 0;
  return `
    <div class="sub-panel history-country-detail">
      <div class="detail-header compact-header">
        <h2 class="panel-title">${escapeHtml(label)}</h2>
        <span class="badge ${anomalies.length || result.dataQualityAnomalyCount ? "warn" : "ok"}">${anomalies.length || result.dataQualityAnomalyCount ? "有异常" : "正常"}</span>
      </div>
      <div class="auto-summary small-summary">
        ${summaryItem("检查卡片", result.checkedCardCount || 0)}
        ${summaryItem("覆盖看板", result.dashboardCount || 0)}
        ${summaryItem("规则异常", result.anomalyCount || 0)}
        ${summaryItem("数据质量异常", result.dataQualityAnomalyCount || 0)}
      </div>
      ${renderDashboardScanDetails(result) || renderHistoryDashboardSummary(result)}
      ${renderHistoryAnomalyInsights(result, anomalies, hasDashboardAnomalySummary)}
    </div>
  `;
}

function renderHistoryDashboardSummary(result) {
  const dashboards = result.checkedDashboards || [];
  if (!dashboards.length) {
    return "";
  }
  return `
    <div class="sub-panel dashboard-scan-details">
      <h2 class="panel-title">看板扫描摘要</h2>
      <div class="table-wrap dashboard-summary-table">
        <table>
          <thead>
            <tr>
              <th>国家</th>
              <th>看板</th>
              <th>链接</th>
              <th>检查卡片</th>
              <th>查询失败</th>
              <th>异常数量</th>
            </tr>
          </thead>
          <tbody>
            ${dashboards.map((dashboard) => `
              <tr>
                <td>${escapeHtml([dashboard.countryName, dashboard.countryCode].filter(Boolean).join(" / ") || "-")}</td>
                <td>${escapeHtml(dashboard.dashboardTitle || "-")}</td>
                <td>${dashboard.dashboardUrl ? `<a class="link-button compact-link" href="${escapeHtml(dashboard.dashboardUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
                <td>${escapeHtml(dashboard.checkedCardCount || 0)}</td>
                <td>${escapeHtml(dashboard.failedCardCount || 0)}</td>
                <td>${escapeHtml(dashboard.anomalyCount || 0)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="muted">这条历史产生于完整明细保存上线前，因此只展示当时已保存的看板摘要。</p>
    </div>
  `;
}

function renderHistoryAnomalyTable(anomalies) {
  if (!anomalies.length) {
    return `<p class="success">该范围没有规则异常。</p>`;
  }
  return `
    <details class="sub-panel anomaly-detail-panel">
      <summary class="detail-header compact-header anomaly-detail-summary">
        <div>
          <h2 class="panel-title">异常原因与波动详情</h2>
          <p class="muted">默认折叠，展开后可查看每条异常的当前值、基准值、变化幅度、统计时间和原始判定消息。</p>
        </div>
        <span class="badge warn">${escapeHtml(anomalies.length)} 条，点击展开</span>
      </summary>
      <div class="anomaly-detail-list">
        ${anomalies.map((anomaly, index) => {
          const detail = parseAnomalyMessage(anomaly.message || "");
          const reason = detail.reason || ruleTypeLabel(anomaly.type);
          const changeLabel = detail.changeValue || ruleTypeLabel(anomaly.type);
          return `
            <article class="anomaly-detail-card">
              <div class="anomaly-detail-card-head">
                <div>
                  <span class="anomaly-index">#${index + 1}</span>
                  <strong>${escapeHtml(anomaly.cardTitle || "-")}</strong>
                  <small>${escapeHtml(anomaly.dashboardTitle || "-")} · ${escapeHtml(ruleTypeLabel(anomaly.type))}</small>
                </div>
                <span class="badge ${detail.changeValue ? "warn" : "idle"}">${escapeHtml(changeLabel)}</span>
              </div>
              <div class="anomaly-detail-metrics">
                ${renderAnomalyDetailMetric("当前值", detail.currentValue || "-")}
                ${renderAnomalyDetailMetric("基准值", detail.baselineValue || "-")}
                ${renderAnomalyDetailMetric("统计时间", detail.timeText || "-")}
                ${renderAnomalyDetailMetric("判定", reason)}
              </div>
              <div class="anomaly-detail-reason">
                <span>原始消息</span>
                <p>${escapeHtml(anomaly.message || "-")}</p>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </details>
  `;
}

function renderAnomalyDetailMetric(label, value) {
  return `
    <div class="anomaly-detail-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderHistoryAnomalyInsights(result, anomalies, hasDashboardAnomalySummary) {
  if (anomalies.length) {
    return renderHistoryAnomalyTable(anomalies);
  }
  if (hasDashboardAnomalySummary) {
    return `
      <div class="sandbox-status warn">
        <strong>这条历史只有看板级摘要</strong>
        <span>当时还没有保存每条异常的详细原因，只能看到上方每个看板的异常数量。重新运行一次巡检后，新的历史会展示具体卡片、触发原因、当前值、基准值和波动幅度。</span>
      </div>
    `;
  }
  return `<p class="success">该范围没有规则异常。</p>`;
}

function parseAnomalyMessage(message) {
  const text = String(message || "");
  const detail = {
    reason: "",
    currentValue: "",
    baselineValue: "",
    changeValue: "",
    timeText: "",
  };
  if (/缺少|没有|最新日期|必须存在|查询失败|返回为空|无数据/.test(text)) {
    detail.reason = "数据缺失或查询异常";
  } else if (/波动|变化|从 .* 到 /.test(text)) {
    detail.reason = "指标波动超阈值";
  }

  const fromTo = text.match(/从\s*([^，,\s]+)\s*到\s*([^，,\s]+)/);
  if (fromTo) {
    detail.baselineValue = fromTo[1];
    detail.currentValue = fromTo[2];
  }

  const change = text.match(/(?:波动|变化)\s*([+-]?\d+(?:\.\d+)?%?)/);
  if (change) {
    detail.changeValue = change[1];
  }

  const timeParts = [];
  const statDate = text.match(/(?:统计日期|stat_date|注册日期|到期日期)\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (statDate) {
    timeParts.push(statDate[1]);
  }
  const compareDate = text.match(/对比\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (compareDate) {
    timeParts.push(`对比 ${compareDate[1]}`);
  }
  const timePoint = text.match(/(?:Asia\/[A-Za-z_]+\s*)?([0-9]{1,2}:[0-9]{2})/);
  if (timePoint) {
    timeParts.push(timePoint[1]);
  }
  detail.timeText = timeParts.join(" / ");
  return detail;
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
    <div class="schedule-country-section">
      <div class="detail-header compact-header">
        <h2 class="panel-title">国家定时配置</h2>
        <p class="muted">每个国家可以独立上下线、选择看板范围和通知方式。</p>
      </div>
      <div class="schedule-country-grid">
          ${countries.map((country) => {
            const config = configs.get(country.code) || {};
            const countryDashboards = dashboards.filter((dashboard) => {
              const code = dashboard.countryCode || dashboard.country?.code || "";
              return code === country.code;
            });
            const selectedDashboardUuid = Array.isArray(config.dashboardUuids) ? config.dashboardUuids[0] || "" : "";
            const notifyChannel = config.notifyChannel || "knBot";
            const rowEnabled = Boolean(config.enabled);
            const dashboardCount = countryDashboards.length;
            return `
              <article class="schedule-country-row schedule-country-card ${rowEnabled ? "is-enabled" : ""}" data-country-code="${escapeHtml(country.code || "")}" data-notify-channel="${escapeHtml(notifyChannel)}">
                <div class="schedule-country-card-header">
                  <div>
                    <strong>${escapeHtml(countryLabel(country, countries))}</strong>
                    <span class="badge schedule-country-state ${rowEnabled ? "ok" : "danger"}">${rowEnabled ? "已上线" : "未上线"}</span>
                  </div>
                  <label class="mini-switch">
                    <input class="schedule-country-enabled" type="checkbox" ${rowEnabled ? "checked" : ""}>
                    <span></span>
                    <em>上线</em>
                  </label>
                </div>
                <label>
                  看板范围
                  <select class="schedule-country-dashboard-uuid">
                    <option value="" ${selectedDashboardUuid ? "" : "selected"}>该国家告警巡检看板</option>
                    ${countryDashboards.map((dashboard) => `<option value="${escapeHtml(dashboard.uuid || "")}" ${selectedDashboardUuid === dashboard.uuid ? "selected" : ""}>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "")}</option>`).join("")}
                  </select>
                  <small class="schedule-dashboard-hint">${dashboardCount ? `当前清单 ${escapeHtml(dashboardCount)} 个看板；不选具体看板时扫描全部。` : "当前暂无该国家公共看板清单，请先补充看板后再上线。"} </small>
                </label>
                <label>
                  通知方式
                  <select class="schedule-country-notify-channel">
                    <option value="knBot" ${notifyChannel === "knBot" ? "selected" : ""}>KN Chat 机器人</option>
                    <option value="tv" ${notifyChannel === "tv" ? "selected" : ""}>TV webhook</option>
                  </select>
                </label>
                <label class="kn-target-field">
                  接收人邮箱
                  <input class="schedule-country-recipient-emails" value="${escapeHtml(config.recipientEmails || "")}" placeholder="多个邮箱用逗号分隔">
                </label>
                <label class="tv-target-field">
                  TV bot_id
                  <input class="schedule-country-bot-id" value="${escapeHtml(config.botId || "")}" placeholder="TV bot_id">
                </label>
                <label class="tv-target-field">
                  TV 提醒人
                  <input class="schedule-country-mentions" value="${escapeHtml(config.mentions || "")}" placeholder="多个邮箱用逗号分隔">
                </label>
                <p class="kn-target-field muted-inline">KN Chat 会按邮箱私聊，无需填写提醒人。</p>
              </article>
            `;
          }).join("")}
      </div>
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
  row.classList.toggle("is-enabled", enabled);
}

function updateScheduleOverviewFromDom(root) {
  const enabled = Boolean(root.querySelector("#batch-schedule-enabled")?.checked);
  const enabledBadge = root.querySelector("#schedule-overview-enabled-badge");
  if (enabledBadge) {
    enabledBadge.textContent = enabled ? "已开启" : "已关闭";
    enabledBadge.classList.toggle("ok", enabled);
    enabledBadge.classList.toggle("danger", !enabled);
  }

  const enabledCopy = root.querySelector("#batch-schedule-enabled-copy");
  if (enabledCopy) {
    enabledCopy.textContent = enabled ? "已开启，到点会自动巡检已上线国家" : "已关闭，不会自动触发；仍可手动测试";
  }

  const countryCount = root.querySelector("#schedule-overview-country-count");
  if (countryCount) {
    const rows = [...root.querySelectorAll(".schedule-country-row")];
    const enabledRows = rows.filter((row) => row.querySelector(".schedule-country-enabled")?.checked);
    countryCount.textContent = `${enabledRows.length} / ${rows.length}`;
  }

  const timeInput = root.querySelector("#batch-schedule-daily-run-times");
  const runTimes = root.querySelector("#schedule-overview-run-times");
  if (timeInput && runTimes) {
    const times = parseDailyRunTimes(timeInput.value);
    runTimes.textContent = `${(times.length ? times : ["09:00"]).join(", ")} 北京时间`;
  }

  const nextRun = root.querySelector("#schedule-overview-next-run");
  if (nextRun) {
    nextRun.textContent = enabled ? "保存后重新计算" : "未启用";
  }
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

function renderTimeChips(times) {
  const safeTimes = times.length ? times : ["09:00"];
  return safeTimes.map((time) => `<span class="time-chip">${escapeHtml(time)}</span>`).join("");
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
      <div class="table-wrap dashboard-summary-table">
        <table>
          <thead>
            <tr>
              <th>国家</th>
              <th>看板</th>
              <th>链接</th>
              <th>检查卡片</th>
              <th>查询失败</th>
              <th>异常数量</th>
              <th>状态</th>
              <th>异常概述</th>
            </tr>
          </thead>
          <tbody>
            ${dashboardRows.map((row) => `
              <tr>
                <td>${escapeHtml([row.countryName, row.countryCode].filter(Boolean).join(" / ") || "-")}</td>
                <td>${escapeHtml(row.dashboardTitle || "-")}</td>
                <td>${row.dashboardUrl ? `<a class="link-button compact-link" href="${escapeHtml(row.dashboardUrl)}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
                <td>${escapeHtml(row.checkedCardCount)}</td>
                <td>${escapeHtml(row.failedCardCount)}</td>
                <td>${escapeHtml(row.anomalyCount)}</td>
                <td><span class="badge ${escapeHtml(row.badgeClass)}">${escapeHtml(row.statusText)}</span></td>
                <td>${escapeHtml(row.issueSummary || "-")}</td>
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
        dashboardUrl: card.dashboardUrl || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
        cards: [],
        anomalySamples: [],
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
        dashboardUrl: anomaly.dashboardUrl || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
        cards: [],
        anomalySamples: [],
      });
    }
    const group = groups.get(key);
    group.anomalyCount += 1;
    if (!group.dashboardUrl && anomaly.dashboardUrl) {
      group.dashboardUrl = anomaly.dashboardUrl;
    }
    const anomalySample = summarizeAnomalySituation(anomaly);
    if (group.anomalySamples.length < 4 && !group.anomalySamples.includes(anomalySample)) {
      group.anomalySamples.push(anomalySample);
    }
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
      issueSummary: summarizeDashboardIssue(group),
    };
  });
}

function summarizeDashboardIssue(group) {
  const parts = [];
  if (group.failedCardCount > 0) {
    parts.push(`查询失败 ${group.failedCardCount} 张`);
  }
  if (group.anomalyCount > 0) {
    const sampleText = group.anomalySamples.length ? `：${group.anomalySamples.join("；")}` : "";
    parts.push(`发现 ${group.anomalyCount} 条异常${sampleText}`);
  }
  if (!parts.length) {
    return `无异常，已扫描 ${group.checkedCardCount || 0} 张卡片`;
  }
  return parts.join("；");
}

function summarizeAnomalySituation(anomaly) {
  const cardTitle = anomaly.cardTitle || "未命名卡片";
  const detail = parseAnomalyMessage(anomaly.message || "");
  const pieces = [];
  if (detail.reason) {
    pieces.push(detail.reason);
  }
  if (detail.reason === "数据缺失或查询异常" && anomaly.message) {
    pieces.push(shortenText(anomaly.message, 72));
  }
  if (detail.baselineValue || detail.currentValue) {
    pieces.push(`${detail.baselineValue || "-"} → ${detail.currentValue || "-"}`);
  }
  if (detail.changeValue) {
    pieces.push(`变化 ${detail.changeValue}`);
  }
  if (detail.timeText) {
    pieces.push(detail.timeText);
  }
  if (!pieces.length && anomaly.message) {
    pieces.push(shortenText(anomaly.message, 56));
  }
  return `${cardTitle}：${pieces.join("，") || ruleTypeLabel(anomaly.type)}`;
}

function shortenText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
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

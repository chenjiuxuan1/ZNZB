import { apiGet, apiPost, apiPut } from "../api.js";
import { getDashboards, isDashboardExecutable, state } from "../state.js";
import { countryLabel, escapeHtml, json, ruleTypeLabel } from "../view-utils.js";

const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";
const ALL_COUNTRIES = "__all__";

export function renderBatchCheck(root) {
  const countries = state.countries?.countries || [];
  const dashboards = getDashboards();
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

  if (activeTab === "schedule") {
    void ensureBatchScheduleProgressPolling(root);
  } else {
    stopBatchScheduleProgressPolling();
  }

  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">定时巡检</h1>
        <p class="page-note">统一查看 Metabase、Wattrel 和 DS 调度巡检；手动巡检、定时任务和历史明细分区管理。</p>
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

  root.querySelectorAll("[data-metabase-anomaly-analysis]").forEach((button) => {
    button.addEventListener("click", async () => {
      const result = root.querySelector(`#${button.dataset.analysisResultId}`);
      void startMetabaseAnomalyAnalysis({ button, result });
    });
  });
  root.querySelectorAll("[data-view-dashboard-fluctuations]").forEach((button) => {
    button.addEventListener("click", () => {
      const route = buildDashboardFluctuationRoute({
        runId: button.dataset.runId,
        countryCode: button.dataset.countryCode,
        dashboardUrl: button.dataset.dashboardUrl,
        dashboardTitle: button.dataset.dashboardTitle,
      });
      window.open(`#${route}`, "_blank", "noopener");
    });
  });
  bindMetabaseAnalysisRetryButtons(root);
  root.querySelector(".schedule-country-progress-details")?.addEventListener("toggle", (event) => {
    state.batchScheduleCountryDetailsOpen = Boolean(event.currentTarget?.open);
  });
  const historyRunId = state.routeQuery?.historyRunId;
  if (historyRunId && state.metabaseRunAnalyses?.[historyRunId] === undefined) {
    void loadRunAnalyses(root, historyRunId);
  }

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
   setButtonBusy(root.querySelector("#refresh-batch-history"), "刷新中...");
   await reloadBatchHistory(root);
 });
  root.querySelector("#rerun-ai-analysis")?.addEventListener("click", async () => {
    const btn = root.querySelector("#rerun-ai-analysis");
    const historyRunId = btn?.dataset?.historyRunId;
    if (!historyRunId) return;
    btn.disabled = true;
    btn.textContent = "AI 分析中...";
    try {
      const started = await apiPost("/api/metabase-anomaly-analysis/rerun", { historyRunId });
      const poll = async () => {
        const progress = await apiGet("/api/batch-schedule/progress");
        const stage = (progress.stages || []).find((item) => item.key === "ai_analysis") || {};
        btn.textContent = `AI 分析中（${stage.completed || 0}/${stage.total || 0}）`;
        if (["success", "failed", "partial_failed"].includes(progress.status)) {
          btn.textContent = progress.status === "success" ? `AI 分析完成（${stage.completed || 0}/${stage.total || 0}）` : "AI 分析失败";
          btn.disabled = false;
          if (started.runId) {
            state.routeQuery = { historyRunId: started.runId };
            window.history.replaceState(null, "", `#/batch-check?historyRunId=${encodeURIComponent(started.runId)}`);
          }
          await reloadBatchHistory(root);
          renderBatchCheck(root);
          return;
        }
        setTimeout(() => void poll(), 2000);
      };
      void poll();
    } catch (error) {
      btn.textContent = "AI 分析失败";
      console.error("rerun failed:", error);
      setTimeout(() => { btn.textContent = "重新 AI 分析"; btn.disabled = false; }, 3000);
    }
  });
 root.querySelector("#load-batch-history")?.addEventListener("click", async () => {
    setButtonBusy(root.querySelector("#load-batch-history"), "正在加载...");
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
      const runResp = await apiPost("/api/batch-schedule/run-now", {});
      if (runResp.error) {
        state.batchScheduleStatus = {
          type: "warn",
          title: "巡检已在运行中",
          detail: runResp.error,
        };
        startBatchScheduleProgressPolling(root);
      } else {
        startBatchScheduleProgressPolling(root);
      }
    } catch (error) {
      stopBatchScheduleProgressPolling();
      await refreshBatchScheduleProgress().catch(() => {});
      state.batchScheduleError = error.payload?.errors?.join("\n") || error.message;
      state.batchScheduleStatus = {
        type: "error",
        title: "定时巡检测试失败",
        detail: "请检查已启用国家、看板范围和通知接收目标。",
      };
      renderBatchCheck(root);
    }
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

function bindMetabaseAnalysisRetryButtons(root) {
  root.querySelectorAll("[data-metabase-anomaly-retry]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const result = root.querySelector(`#${button.dataset.analysisResultId}`);
      void startMetabaseAnomalyAnalysis({ button, result, force: true });
    });
  });
}

async function startMetabaseAnomalyAnalysis({ button, result, force = false }) {
  const previousHtml = force && result ? result.innerHTML : "";
  button.disabled = true;
  button.textContent = force ? "重新分析中..." : "AI 分析中...";
  if (result && !force) result.innerHTML = `<p class="muted">正在基于本次巡检证据分析，通常需要数秒。</p>`;
  if (result && force) result.insertAdjacentHTML("beforeend", `<p class="muted">正在重新发起取证分析，旧结论会保留至新结果完成。</p>`);
  try {
    const analysis = await apiPost("/api/metabase-anomaly-analysis", {
      runId: button.dataset.runId,
      countryCode: button.dataset.countryCode,
      anomalyIndex: Number(button.dataset.anomalyIndex),
      force,
    });
    if (analysis.pending) {
      if (result && !force) result.innerHTML = `<p class="muted">数据侧取证任务已受理，正在查询 Metabase、StarRocks 与 DS 状态。此过程不会影响原始告警。</p>`;
      button.textContent = force ? "重新取证中..." : "分析取证中...";
      void waitForMetabaseAnalysis({ button, result, analysis, previousHtml });
      return;
    }
    if (result) result.innerHTML = renderMetabaseAnomalyAnalysis(analysis);
    button.textContent = analysis.cached ? "查看缓存分析" : "查看 AI 分析";
    bindMetabaseAnalysisRetryButtons(result?.parentElement || document);
  } catch (error) {
    if (result) result.innerHTML = force && previousHtml
      ? `${previousHtml}<p class="error">重新分析失败：${escapeHtml(error.message || "请稍后重试")}</p>`
      : `<p class="error">${escapeHtml(error.message || "AI 分析失败")}</p>`;
    button.textContent = force ? "重新 AI 分析" : "AI 分析原因";
  } finally {
    button.disabled = false;
  }
}

async function waitForMetabaseAnalysis({ button, result, analysis, previousHtml = "" }) {
  const params = new URLSearchParams({
    runId: analysis.runId || "",
    countryCode: analysis.countryCode || "",
    anomalyIndex: String(analysis.anomalyIndex ?? ""),
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      const latest = await apiGet(`/api/metabase-anomaly-analysis?${params}`);
      if (latest.status !== "pending" && !latest.pending) {
        if (result) result.innerHTML = renderMetabaseAnomalyAnalysis(latest);
        button.textContent = "查看 AI 分析";
        button.disabled = false;
        bindMetabaseAnalysisRetryButtons(result?.parentElement || document);
        return;
      }
    } catch (error) {
      if (result) result.innerHTML = `<p class="error">分析状态读取失败：${escapeHtml(error.message || "请稍后刷新")}</p>`;
      button.textContent = "AI 分析原因";
      button.disabled = false;
      return;
    }
  }
  if (result) result.innerHTML = previousHtml
    ? `${previousHtml}<p class="muted">数据侧取证仍在进行中，请稍后再次点击查看结果。原始异常和通知不受影响。</p>`
    : `<p class="muted">数据侧取证仍在进行中，请稍后再次点击查看结果。原始异常和通知不受影响。</p>`;
  button.textContent = "查看分析进度";
  button.disabled = false;
}

function renderBatchHeroStats() {
  const summary = state.summary || {};
  const schedule = state.batchSchedule || {};
  const historyRuns = state.batchHistory?.runs || [];
  const latestRun = historyRuns[0] || null;
  return `
    <div class="hero-stats" aria-label="定时巡检概览">
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
  const running = state.batchCheckStatus?.type === "loading";
  return `
    <section class="panel batch-controls">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">手动巡检</h2>
          <p class="muted">适合临时验证某个国家或单个看板；健康结果不会发通知，只有异常才发送。</p>
        </div>
        <button class="primary" id="run-batch-check" ${running ? "disabled" : ""} aria-busy="${running}">${running ? "巡检进行中..." : "开始巡检并发送 TV"}</button>
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
                ${countryDashboards.map((dashboard) => `<option value="${escapeHtml(dashboard.uuid || "")}" ${selectedDashboard === dashboard ? "selected" : ""} ${isDashboardExecutable(dashboard) ? "" : "disabled"}>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "")}${isDashboardExecutable(dashboard) ? "" : "（待发现）"}</option>`).join("")}
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
    params.set("limit", "3");
    state.batchHistory = await apiGet(`/api/batch-history?${params}`);
    state.batchHistoryLoaded = true;
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

function setButtonBusy(button, label) {
  if (!button) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = label;
}

function startBatchScheduleProgressPolling(root) {
  stopBatchScheduleProgressPolling();
  void pollBatchScheduleProgress(root);
}

function stopBatchScheduleProgressPolling() {
  state.batchScheduleProgressPollVersion += 1;
  if (state.batchScheduleProgressTimer) {
    window.clearTimeout(state.batchScheduleProgressTimer);
    state.batchScheduleProgressTimer = null;
  }
}

async function ensureBatchScheduleProgressPolling(root) {
  if (!isScheduleProgressViewOpen() || state.batchScheduleProgressInFlight || state.batchScheduleProgressTimer) return;
  await pollBatchScheduleProgress(root);
}

async function pollBatchScheduleProgress(root) {
  if (!isScheduleProgressViewOpen() || state.batchScheduleProgressInFlight) return;
  const version = state.batchScheduleProgressPollVersion;
  state.batchScheduleProgressInFlight = true;
  try {
    const progress = await refreshBatchScheduleProgress();
    if (version !== state.batchScheduleProgressPollVersion || !isScheduleProgressViewOpen()) return;
    renderBatchCheck(root);
    if (isFinishedScheduleProgress(progress)) {
      stopBatchScheduleProgressPolling();
      state.batchSchedule = await apiGet("/api/batch-schedule");
      await reloadBatchHistory(root);
      if (progress.status === "failed") {
        state.batchScheduleStatus = {
          type: "error",
          title: "定时巡检测试失败",
          detail: progress.error || "运行失败",
        };
      } else {
        const summary = progress.result || {};
        state.batchScheduleStatus = {
          type: summary.failedCount > 0 ? "error" : "success",
          title: summary.failedCount > 0 ? "定时巡检测试完成，部分国家失败" : "定时巡检测试完成",
          detail: `国家 ${summary.countryCount || 0} 个，成功 ${summary.successCount || 0} 个，失败 ${summary.failedCount || 0} 个；检查 ${summary.checkedCardCount || 0} 张卡片，异常 ${summary.anomalyCount || 0} 条。`,
        };
      }
      renderBatchCheck(root);
      return;
    }
  } catch {
    // Keep the last visible progress and retry. A transient API failure must not
    // leave a live patrol page permanently frozen.
  } finally {
    state.batchScheduleProgressInFlight = false;
  }
  if (version !== state.batchScheduleProgressPollVersion || !shouldContinueScheduleProgressPolling()) return;
  state.batchScheduleProgressTimer = window.setTimeout(() => {
    state.batchScheduleProgressTimer = null;
    void pollBatchScheduleProgress(root);
  }, 2000);
}

function isScheduleProgressViewOpen() {
  return state.route === "/batch-check" && state.batchCheckTab === "schedule" && !state.routeQuery?.historyRunId;
}

function isFinishedScheduleProgress(progress = {}) {
  return ["success", "partial_failed", "failed"].includes(progress.status);
}

function shouldContinueScheduleProgressPolling() {
  return isScheduleProgressViewOpen() && (
    ["running", "sending", "ai_analyzing", "queued"].includes(state.batchScheduleProgress?.status)
    || state.batchScheduleStatus?.type === "loading"
  );
}

function renderBatchSchedulePanel() {
  const schedule = state.batchSchedule || {};
  const enabled = Boolean(schedule.enabled);
  const status = state.batchScheduleStatus;
  const saving = status?.type === "loading" && /保存/.test(status.title || "");
  const running = status?.type === "loading" && /试跑/.test(status.title || "");
  return `
    <section class="panel schedule-panel">
      <div class="schedule-title-row">
        <div>
          <h2 class="panel-title section-title">定时巡检</h2>
          <p class="muted">按国家配置自动巡检。总开关控制是否到点自动运行，国家开关控制该国家是否参与。</p>
        </div>
        <div class="button-group">
          <button id="save-batch-schedule" class="secondary" ${saving || running ? "disabled" : ""} aria-busy="${saving}">${saving ? "保存中..." : "保存配置"}</button>
          <button id="run-batch-schedule-now" class="primary" ${saving || running ? "disabled" : ""} aria-busy="${running}">${running ? "正在启动..." : "立即运行测试"}</button>
        </div>
      </div>
      ${renderScheduleOverview(schedule)}
      ${renderScheduleRunProgress()}
      <div class="schedule-config-card">
        <div class="schedule-switch-row">
          <label class="switch-field">
            <input id="batch-schedule-enabled" type="checkbox" ${enabled ? "checked" : ""}>
            <span class="switch-track"></span>
            <span>
              <strong>自动触发</strong>
              <small id="batch-schedule-enabled-copy">${enabled ? "已开启，到点会自动巡检已上线国家" : "已关闭，不会自动触发；仍可手动测试"}</small>
            </span>
          </label>
          <label class="switch-field">
            <input id="batch-include-ds-scheduler" type="checkbox" ${schedule.includeDsScheduler ? "checked" : ""}>
            <span class="switch-track"></span>
            <span>
              <strong>同时执行 DS 调度巡检</strong>
              <small>开启后检查所有已配置的 DS 项目，并共用本页通知配置。</small>
            </span>
          </label>
          <label class="switch-field">
            <input id="batch-include-hive-scheduler" type="checkbox" ${schedule.includeHiveScheduler ? "checked" : ""}>
            <span class="switch-track"></span>
            <span>
              <strong>同时执行 HIVE 调度巡检</strong>
              <small>开启后检查 HIVE 页面中已启用国家和项目，并按国家精准提醒。</small>
            </span>
          </label>
        </div>
        <div class="field schedule-run-times-field">
          <label>每日运行时间（北京时间，可多个）</label>
          <input id="batch-schedule-daily-run-times" value="${escapeHtml(formatDailyRunTimes(schedule))}" placeholder="例如：09:00, 14:30, 20:00">
          <div id="batch-schedule-time-preview" class="time-chip-row">${renderTimeChips(parseDailyRunTimes(formatDailyRunTimes(schedule)))}</div>
          <small class="muted">多个时间用逗号、空格或换行分隔；服务每天会在这些时间点各运行一次。</small>
        </div>
        <div class="field schedule-next-run-field">
          <label>下次运行</label>
          <input value="${escapeHtml(schedule.enabled ? formatDisplayTime(schedule.nextRunAt) : "未启用")}" readonly>
        </div>
        <div class="field schedule-last-run-field">
          <label>上次运行</label>
          <input value="${escapeHtml(formatDisplayTime(schedule.lastRunAt))}" readonly>
        </div>
      </div>
      <div class="schedule-help">
        <strong>怎么下线</strong>
        <span>关闭“自动触发”并保存，会停止所有到点自动巡检；关闭某个国家卡片里的“上线”并保存，只会下线该国家。选择 KN Chat 机器人时可同时填写接收人邮箱和群聊 chat_id；选择 TV webhook 时填写 TV bot_id 和提醒人。</span>
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
  const countryPercent = total ? (completed / total) * 100 : 0;
  const currentLabel = [progress.currentCountryName, progress.currentCountryCode].filter(Boolean).join(" / ");
  const stages = progress.stages || [];
  const finishedStages = stages.filter((stage) => ["success", "skipped", "partial_failed"].includes(stage.status)).length;
  const runningStage = stages.some((stage) => ["running", "queued"].includes(stage.status)) ? 0.5 : 0;
  const percent = stages.length ? Math.round(((finishedStages + runningStage) / stages.length) * 100) : Math.round(countryPercent);
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
      <div class="schedule-stage-list" aria-label="巡检阶段">
        ${stages.map((stage, index) => `
          <article class="schedule-stage ${escapeHtml(stage.status || "pending")}">
            <span class="schedule-stage-index">${index + 1}</span>
            <div><strong>${escapeHtml(stage.label || "-")}</strong><small>${escapeHtml(stage.detail || "等待开始")}</small>${stage.key === "ai_analysis" ? renderAiStageCounters(stage) : ""}</div>
            <span class="badge ${escapeHtml(scheduleProgressBadge(stage.status))}">${escapeHtml(scheduleProgressLabel(stage.status))}</span>
          </article>
        `).join("")}
      </div>
      <details class="schedule-country-progress-details" ${state.batchScheduleCountryDetailsOpen ? "open" : ""}>
        <summary>查看国家巡检明细（${escapeHtml(completed)}/${escapeHtml(total)}）</summary>
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
      </details>
    </div>
  `;
}

function renderAiStageCounters(stage = {}) {
  const total = Number(stage.total || 0);
  if (!total) return "";
  return `
    <span class="schedule-ai-counters"><em>看板分析 ${escapeHtml(stage.completed || 0)}/${escapeHtml(total)}</em></span>
    ${renderAiBatchDetails(stage)}
  `;
}

function renderAiBatchDetails(stage = {}) {
  const details = Array.isArray(stage.details) ? stage.details : [];
  if (!details.length) return "";
  const priority = { timed_out: 0, failed: 1, partial_failed: 2, running: 3, submitted: 4, completed: 5 };
  const visible = [...details]
    .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 12);
  const problemCount = details.filter((item) => ["timed_out", "failed", "partial_failed"].includes(item.status)).length;
  const summary = problemCount
    ? `查看 AI 取证明细（异常 ${problemCount}/${details.length}）`
    : `查看 AI 取证明细（${details.length} 个看板）`;
  return `
    <details class="schedule-ai-detail-list">
      <summary>${escapeHtml(summary)}</summary>
      <div class="schedule-ai-detail-items">
        ${visible.map((item) => renderAiBatchDetailItem(item)).join("")}
      </div>
    </details>
  `;
}

function renderAiBatchDetailItem(item = {}) {
  const status = String(item.status || "running");
  const title = item.dashboardTitle || item.dashboardUuid || item.groupKey || "-";
  const meta = [
    item.countryCode ? `国家 ${item.countryCode}` : "",
    item.caseCount ? `指标 ${item.caseCount} 个` : "",
    item.retry ? "重刷" : "首次",
    item.batchId ? `batch ${item.batchId}` : item.groupKey ? `分组 ${item.groupKey}` : "",
  ].filter(Boolean).join(" · ");
  const indexes = Array.isArray(item.anomalyIndexes) && item.anomalyIndexes.length ? `异常序号：${item.anomalyIndexes.join(", ")}` : "";
  const reason = item.reason || (status === "timed_out" ? "等待 AI 回调超过等待窗口" : "");
  return `
    <article class="schedule-ai-detail-item ${escapeHtml(status)}">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(meta || "-")}</span>
        ${indexes ? `<small>${escapeHtml(indexes)}</small>` : ""}
        ${reason ? `<small class="schedule-ai-detail-reason">${escapeHtml(reason)}</small>` : ""}
      </div>
      <span class="badge ${escapeHtml(scheduleProgressBadge(status))}">${escapeHtml(scheduleProgressLabel(status))}</span>
    </article>
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
  if (progress.status === "ai_analyzing") {
    const aiStage = (progress.stages || []).find((item) => item.key === "ai_analysis");
    return aiStage?.detail || "国家巡检已完成，正在等待 AI 取证结论；通知和历史记录会在结论收敛后生成。";
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
    submitted: "已提交",
    sending: "发送中",
    queued: "已排队",
    skipped: "已跳过",
    success: "完成",
    completed: "完成",
    partial_failed: "部分失败",
    failed: "失败",
    timed_out: "超时",
  };
  return labels[status] || "未开始";
}

function scheduleProgressBadge(status) {
  if (status === "success") return "ok";
  if (status === "completed") return "ok";
  if (status === "failed" || status === "partial_failed" || status === "timed_out") return "danger";
  if (status === "running" || status === "sending" || status === "queued") return "warn";
  return "idle";
}

function renderBatchHistoryPanel() {
  const countries = state.countries?.countries || [];
  const filters = state.batchHistoryFilters || {};
  const history = state.batchHistory || { runs: [] };
  const runs = history.runs || [];
  if (!state.batchHistoryLoaded) {
    const loading = state.batchHistoryStatus?.type === "loading";
    return `
      <section class="panel schedule-history-panel">
        <div class="detail-header compact-header"><h2 class="panel-title">定时巡检历史</h2></div>
        <p class="muted">历史记录可能较大，按需加载不会影响当前巡检。</p>
        ${renderBatchHistoryStatus()}
        <button id="load-batch-history" class="primary" type="button" ${loading ? "disabled" : ""} aria-busy="${loading}">${loading ? "正在加载..." : "加载最近 3 次巡检记录"}</button>
      </section>`;
  }
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
  if (!state.batchHistory) {
    const status = state.batchHistoryStatus;
    return `
      <section class="panel history-detail-page">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">巡检历史详情</h2>
            <p class="muted">${escapeHtml(status?.detail || "正在加载本次巡检详情...")}</p>
          </div>
          <a class="link-button" href="#/batch-check">返回定时巡检</a>
        </div>
      </section>
    `;
  }
  const history = state.batchHistory;
  const run = (history.runs || []).find((item) => String(item.id || "") === String(runId));
  if (!run) {
    return `
      <section class="panel history-detail-page">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">巡检历史详情</h2>
            <p class="muted">未找到这次巡检记录，可能本地历史已被清理。</p>
          </div>
          <a class="link-button" href="#/batch-check">返回定时巡检</a>
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
          <button id="rerun-ai-analysis" class="secondary" type="button" data-history-run-id="${escapeHtml(run.id || "")}">重新 AI 分析</button>
         <a class="link-button" href="#/batch-check">返回定时巡检</a>
       </div>
      </div>
      <div class="auto-summary">
        ${summaryItem("运行时间", formatDisplayTime(run.startedAt))}
        ${summaryItem("国家", `${run.successCount || 0}/${run.countryCount || 0}`)}
        ${summaryItem("检查卡片", run.checkedCardCount || 0)}
        ${summaryItem("异常数量", (run.anomalyCount || 0) + (run.dataQualityAnomalyCount || 0))}
      </div>
      ${renderHistoryCountryTabs(run, selectedCountryCode)}
      ${countryRuns.length ? countryRuns.map((countryRun) => renderHistoryCountryDetail(countryRun, run.id)).join("") : `<p class="muted">当前筛选国家没有这次巡检记录。</p>`}
      ${renderHistoryExternalDetails(run)}
      <details class="advanced compact">
        <summary>查看这次巡检完整 JSON</summary>
        <pre class="code">${escapeHtml(json(run))}</pre>
      </details>
    </section>
  `;
}

function renderHistoryExternalDetails(run) {
  const sections = [
    renderHistoryWattrelDetails(run.wattrelSummary),
    renderHistoryDsDetails(run.dsSchedulerSummary, run.dsSchedulerError),
  ].filter(Boolean);
  return sections.length ? sections.join("") : "";
}

export function renderHistoryWattrelDetails(summary) {
  if (!summary) return "";
  const countries = summary.countries || [];
  return `
    <div class="sub-panel history-country-detail">
      <div class="detail-header compact-header">
        <h2 class="panel-title">Wattrel 数据质量</h2>
        <span class="badge ${summary.total || summary.failedCount ? "warn" : "ok"}">${summary.total || 0} 条未处理</span>
      </div>
      <p class="muted">巡检时间：${escapeHtml(formatDisplayTime(summary.checkedAt))}；只统计 result=1 且未修复的告警。</p>
      ${countries.length ? `<ul class="history-dashboard-list">${countries.map((country) => `
        <li>
          ${escapeHtml([country.countryName, country.countryCode].filter(Boolean).join(" / ") || "-")}：${escapeHtml(country.count || 0)} 条${country.status === "failed" ? `，查询失败：${escapeHtml(country.error || "未知错误")}` : ""}
          ${renderHistoryWattrelAnomalies(country.anomalies || [])}
        </li>
      `).join("")}</ul>` : `<p class="muted">本次未配置 Wattrel 国家范围。</p>`}
    </div>
  `;
}

function renderHistoryWattrelAnomalies(anomalies) {
  if (!anomalies.length) return "";
  return `
    <ul class="history-dashboard-list">
      ${anomalies.map((item) => `
        <li>
          <strong>${escapeHtml(item.name || item.cardTitle || "未命名校验")}</strong>：目标表 ${escapeHtml(item.destTbl || item.cardTitle || "-")}；
          源表 ${escapeHtml(item.srcTbl || "-")}；期望值 ${escapeHtml(formatHistoryValue(item.expectedValue))}，实际值 ${escapeHtml(formatHistoryValue(item.actualValue))}，差值 ${escapeHtml(formatHistoryValue(item.diff))}
        </li>
      `).join("")}
    </ul>
  `;
}

export function renderHistoryDsDetails(summary, error) {
  if (!summary && !error) return "";
  if (!summary) {
    return `<div class="sub-panel history-country-detail"><h2 class="panel-title">DS 调度监控</h2><p class="error">${escapeHtml(error)}</p></div>`;
  }
  if (summary.skipped) {
    return `<div class="sub-panel history-country-detail"><h2 class="panel-title">DS 调度监控</h2><p class="muted">本次未执行：${escapeHtml(summary.reason || "没有可巡检的国家")}</p></div>`;
  }
  const countries = summary.countries || [];
  return `
    <div class="sub-panel history-country-detail">
      <div class="detail-header compact-header">
        <h2 class="panel-title">DS 调度监控</h2>
        <span class="badge ${summary.totalStuck || summary.totalStale || summary.totalFailed || summary.failedCountries ? "warn" : "ok"}">卡死 ${summary.totalStuck || 0}，离线 ${summary.totalStale || 0}，执行失败 ${summary.totalFailed || 0}</span>
      </div>
      <p class="muted">检查 ${escapeHtml(summary.totalChecked || 0)} 个工作流，覆盖 ${escapeHtml(summary.totalCountries || 0)} 个国家。</p>
      ${countries.length ? `<ul class="history-dashboard-list">${countries.map((country) => `
        <li>
          ${escapeHtml([country.countryName, country.country].filter(Boolean).join(" / ") || "-")}：卡死 ${escapeHtml(country.stuckCount || 0)}，离线 ${escapeHtml(country.staleCount || 0)}，执行失败 ${escapeHtml(country.failedCount || 0)}，检查 ${escapeHtml(country.checkedWorkflows || 0)}${country.error ? `，检查失败：${escapeHtml(country.error)}` : ""}
          ${renderHistoryDsProjects(country.projects || [])}
          ${renderHistoryDsWorkflows(country.stuckWorkflows || [], country.staleWorkflows || [], country.failedWorkflows || [])}
        </li>
      `).join("")}</ul>` : ""}
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    </div>
  `;
}

function renderHistoryDsProjects(projects) {
  if (!projects.length) return "";
  return `<ul class="history-dashboard-list">${projects.map((project) => `
    <li>
      项目 ${escapeHtml(project.projectName || project.projectCode || "未命名")}：检查 ${escapeHtml(project.checkedWorkflows || 0)} 个工作流${project.success === false ? `，失败：${escapeHtml(project.error || "未知错误")}` : ""}
      ${renderHistoryCheckedWorkflows(project.checkedWorkflowDetails || [])}
    </li>
  `).join("")}</ul>`;
}

function renderHistoryCheckedWorkflows(workflows) {
  if (!workflows.length) return "";
  return `
    <details class="advanced compact">
      <summary>查看 ${escapeHtml(workflows.length)} 个已扫描工作流</summary>
      <ul class="history-dashboard-list">${workflows.map((workflow) => `
        <li>已扫描：${escapeHtml(workflow.workflowName || workflow.workflowCode || "未命名工作流")} (${escapeHtml(workflow.workflowCode || "-")})</li>
      `).join("")}</ul>
    </details>
  `;
}

function renderHistoryDsWorkflows(stuckWorkflows, staleWorkflows, failedWorkflows) {
  const items = [
    ...stuckWorkflows.map((workflow) => `卡死：${workflow.workflowName || workflow.workflowCode || "未命名工作流"} (${workflow.workflowCode || "-"})，连续失败 ${workflow.consecutiveFailures || 0} 次`),
    ...staleWorkflows.map((workflow) => `离线：${workflow.workflowName || workflow.workflowCode || "未命名工作流"} (${workflow.workflowCode || "-"})，${workflow.staleMessage || workflow.staleReason || "未运行"}`),
    ...failedWorkflows.map((workflow) => `执行失败：${workflow.workflowName || workflow.workflowCode || "未命名工作流"} (${workflow.workflowCode || "-"})，${workflow.failureMessage || workflow.failureReason || "当天定时实例失败"}`),
  ];
  if (!items.length) return "";
  return `<ul class="history-dashboard-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function formatHistoryValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(numeric)
    : String(value);
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

function renderHistoryCountryDetail(countryRun, runId = "") {
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
  const effectiveAnomalyCount = Number(result.anomalyCount ?? anomalies.length ?? 0);
  const hasDashboardAnomalySummary = Number(result.anomalyCount || 0) > 0;
  return `
    <div class="sub-panel history-country-detail">
      <div class="detail-header compact-header">
        <h2 class="panel-title">${escapeHtml(label)}</h2>
        <span class="badge ${effectiveAnomalyCount || result.dataQualityAnomalyCount ? "warn" : "ok"}">${effectiveAnomalyCount || result.dataQualityAnomalyCount ? "有异常" : (anomalies.length ? "AI 分析后无异常" : "正常")}</span>
      </div>
      <div class="auto-summary small-summary">
        ${summaryItem("检查卡片", result.checkedCardCount || 0)}
        ${summaryItem("覆盖看板", result.dashboardCount || 0)}
        ${summaryItem(result.rawAnomalyCount && result.rawAnomalyCount !== effectiveAnomalyCount ? "AI后异常" : "规则异常", effectiveAnomalyCount)}
        ${summaryItem("数据质量异常", result.dataQualityAnomalyCount || 0)}
      </div>
      ${renderDashboardScanDetails(result, { runId, countryCode: countryRun.countryCode || "" }) || renderHistoryDashboardSummary(result, { runId, countryCode: countryRun.countryCode || "" })}
      ${renderHistoryAnomalyInsights(result, anomalies, hasDashboardAnomalySummary, { runId, countryCode: countryRun.countryCode || "" })}
    </div>
  `;
}

function renderHistoryDashboardSummary(result, context = {}) {
  const dashboards = (result.checkedDashboards || []).filter((dashboard) => !isExcludedScanDashboardRow(dashboard));
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
              <th>异常波动</th>
            </tr>
          </thead>
          <tbody>
            ${dashboards.map((dashboard) => `
              <tr>
                <td>${escapeHtml([dashboard.countryName, dashboard.countryCode].filter(Boolean).join(" / ") || "-")}</td>
                <td>${escapeHtml(dashboard.dashboardTitle || "-")}</td>
                <td>${resolveHistoryDashboardUrl(dashboard) ? `<a class="link-button compact-link" href="${escapeHtml(resolveHistoryDashboardUrl(dashboard))}" target="_blank" rel="noreferrer">打开</a>` : "-"}</td>
                <td>${escapeHtml(dashboard.checkedCardCount || 0)}</td>
                <td>${escapeHtml(dashboard.failedCardCount || 0)}</td>
                <td>${escapeHtml(dashboard.anomalyCount || 0)}</td>
                <td>${Number(dashboard.anomalyCount || 0) > 0 && context.runId ? `<button class="link-button compact-link" type="button" data-view-dashboard-fluctuations data-run-id="${escapeHtml(context.runId)}" data-country-code="${escapeHtml(context.countryCode || dashboard.countryCode || "")}" data-dashboard-url="${escapeHtml(dashboard.dashboardUrl || "")}" data-dashboard-title="${escapeHtml(dashboard.dashboardTitle || "")}">打开</button>` : ""}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="muted">这条历史产生于完整明细保存上线前，因此只展示当时已保存的看板摘要。</p>
    </div>
  `;
}

function resolveHistoryDashboardUrl(dashboard = {}) {
  const dashboards = getDashboards();
  const uuid = String(dashboard.dashboardUuid || "").trim();
  const title = String(dashboard.dashboardTitle || "").trim();
  const current = dashboards.find((item) => (
    (uuid && String(item.uuid || "") === uuid)
    || (!uuid && title && [item.title, item.sourcePanelTitle].includes(title) && String(item.countryCode || item.country?.code || "") === String(dashboard.countryCode || ""))
  ));
  return current?.url || dashboard.dashboardUrl || "";
}

function renderHistoryAnomalyTable(anomalies, context = {}) {
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
          const detail = parseAnomalyMessage(anomaly.message || "", anomaly.type);
          const reason = detail.reason || ruleTypeLabel(anomaly.type);
          const changeLabel = detail.changeValue || ruleTypeLabel(anomaly.type);
          const resultId = `metabase-ai-analysis-${encodeURIComponent(`${context.runId}-${context.countryCode}-${index}`).replace(/%/g, "")}`;
          const storedAnalysis = state.metabaseRunAnalyses?.[context.runId]?.[`${context.countryCode}:${index}`];
          const analysesLoading = state.metabaseRunAnalyses?.[context.runId] === null;
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
                ${renderAnomalyDetailMetric("指标", detail.metricName || "-")}
                ${renderAnomalyDetailMetric("维度", detail.dimensionText || "-")}
                ${renderAnomalyDetailMetric("当前值", detail.currentValue || "-")}
                ${renderAnomalyDetailMetric("基准值", detail.baselineValue || "-")}
                ${renderAnomalyDetailMetric("统计时间", detail.timeText || "-")}
                ${renderAnomalyDetailMetric("判定", reason)}
              </div>
              <div class="anomaly-detail-reason">
                <span>原始消息</span>
                <p>${escapeHtml(anomaly.message || "-")}</p>
              </div>
              <div class="button-group">
                <button class="secondary" type="button" data-metabase-anomaly-analysis data-run-id="${escapeHtml(context.runId)}" data-country-code="${escapeHtml(context.countryCode)}" data-anomaly-index="${index}" data-analysis-result-id="${resultId}" ${analysesLoading ? "disabled" : ""} aria-busy="${analysesLoading}">${analysesLoading ? "正在读取 AI 结论..." : "AI 分析原因"}</button>
              </div>
              <div id="${resultId}" class="metabase-anomaly-analysis-result">${analysesLoading ? `<div class="inline-loading"><span></span>正在批量读取本次巡检的 AI 结论...</div>` : storedAnalysis ? renderMetabaseAnomalyAnalysis(storedAnalysis) : ""}</div>
            </article>
          `;
        }).join("")}
      </div>
    </details>
  `;
}

async function loadRunAnalyses(root, runId, attempt = 0) {
  state.metabaseRunAnalyses = { ...(state.metabaseRunAnalyses || {}), [runId]: null };
  renderBatchCheck(root);
  try {
    const payload = await apiGet(`/api/metabase-anomaly-analyses?runId=${encodeURIComponent(runId)}`);
    const byIdentity = Object.fromEntries((payload.analyses || []).map((item) => [`${item.countryCode}:${item.anomalyIndex}`, item]));
    state.metabaseRunAnalyses = { ...(state.metabaseRunAnalyses || {}), [runId]: byIdentity };
    renderBatchCheck(root);
    if (attempt < 36 && (payload.analyses || []).some((item) => item.status === "pending" || item.pending)) {
      scheduleRunAnalysesReload(root, runId, attempt + 1);
    }
  } catch {
    state.metabaseRunAnalyses = { ...(state.metabaseRunAnalyses || {}), [runId]: {} };
    renderBatchCheck(root);
  }
}

function scheduleRunAnalysesReload(root, runId, attempt) {
  if (state.metabaseRunAnalysisPolling?.[runId]) return;
  state.metabaseRunAnalysisPolling = { ...(state.metabaseRunAnalysisPolling || {}), [runId]: true };
  setTimeout(() => {
    state.metabaseRunAnalysisPolling = { ...(state.metabaseRunAnalysisPolling || {}), [runId]: false };
    if (state.routeQuery?.historyRunId === runId) {
      void loadRunAnalyses(root, runId, attempt);
    }
  }, 5_000);
}

export function buildDashboardFluctuationRoute({ runId = "", countryCode = "", dashboardUrl = "", dashboardTitle = "" } = {}) {
  const query = new URLSearchParams();
  if (runId) query.set("runId", runId);
  if (countryCode) query.set("countryCode", countryCode);
  if (dashboardUrl) query.set("dashboardUrl", dashboardUrl);
  if (dashboardTitle) query.set("dashboardTitle", dashboardTitle);
  return `/fluctuation-visual?${query.toString()}`;
}

function renderAnomalyDetailMetric(label, value) {
  return `
    <div class="anomaly-detail-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderHistoryAnomalyInsights(result, anomalies, hasDashboardAnomalySummary, context = {}) {
  if (anomalies.length) {
    return renderHistoryAnomalyTable(anomalies, context);
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

export function renderMetabaseAnomalyAnalysis(response) {
  if (response?.status === "failed") {
    return `<div class="sandbox-status error"><strong>AI 分析失败</strong><span>${escapeHtml(response.error || "n8n/Dify 连接失败，请检查 n8n 是否运行及工作流是否已导入最新模板。")}</span></div>
    <p class="muted">可访问 <code>/api/metabase-anomaly-analysis/diagnostic</code> 查看 Agent 配置与 n8n 连接状态。</p>
    <div class="button-group">
      <button class="secondary" type="button" data-metabase-anomaly-retry data-run-id="${escapeHtml(response.runId || "")}" data-country-code="${escapeHtml(response.countryCode || "")}" data-anomaly-index="${escapeHtml(response.anomalyIndex ?? "")}" data-analysis-result-id="metabase-ai-analysis-${encodeURIComponent(`${response.runId || ""}-${response.countryCode || ""}-${response.anomalyIndex ?? ""}`).replace(/%/g, "")}">重新 AI 分析</button>
    </div>`;
  }
  if (response?.status === "pending" || response?.pending) {
    return `<div class="sandbox-status info"><strong>数据侧取证进行中</strong><span>任务 ${escapeHtml(response.jobId || "-")} 已提交；完成后可查看 StarRocks、血缘和 DS 的核查结论。</span></div>`;
  }
  const analysis = response?.analysis || {};
  const finalVerdict = formatMetabaseFinalVerdict(analysis);
  return `
    <div class="sandbox-status ai-final-verdict ${escapeHtml(finalVerdict.className)}">
      <strong>最终判定：${escapeHtml(finalVerdict.title)}</strong>
      <span>${escapeHtml(finalVerdict.detail)}</span>
    </div>
    <div class="sandbox-status info">
      <strong>AI 数据侧分析${response.cached ? "（缓存）" : ""}</strong>
      <span>${escapeHtml(analysis.summary || "-")}</span>
    </div>
    <div class="ai-analysis-supporting ${escapeHtml(finalVerdict.supportClass)}">
      ${renderMetabaseAnalysisList("可能原因", analysis.possibleCauses)}
      ${renderMetabaseAnalysisList("核查步骤", analysis.verificationSteps)}
      ${renderMetabaseAnalysisList("建议处理", analysis.recommendedActions)}
    </div>
    ${analysis.dataSideVerdict ? `<p class="muted">数据侧判定：${escapeHtml(analysis.dataSideVerdict)}；通知建议：${escapeHtml(analysis.notificationAction || "enrich_only")}</p>` : ""}
    ${analysis.chartVisibility === "hide_verified_normal" ? `<div class="sandbox-status success"><strong>AI 已核验正常（不展示于波动图谱）</strong><span>${escapeHtml(analysis.verificationReason || "本轮查询已确认该点不属于当前数据异常。")}</span></div>` : ""}
    <p class="muted">置信度：${escapeHtml(analysis.confidence || "low")}；限制：${escapeHtml(analysis.limitations || "仅基于本次巡检记录分析。")}</p>
    <div class="button-group">
      <button class="secondary" type="button" data-metabase-anomaly-retry data-run-id="${escapeHtml(response.runId || "")}" data-country-code="${escapeHtml(response.countryCode || "")}" data-anomaly-index="${escapeHtml(response.anomalyIndex ?? "")}" data-analysis-result-id="metabase-ai-analysis-${encodeURIComponent(`${response.runId || ""}-${response.countryCode || ""}-${response.anomalyIndex ?? ""}`).replace(/%/g, "")}">重新 AI 分析</button>
    </div>
  `;
}

function formatMetabaseFinalVerdict(analysis = {}) {
  const verdict = String(analysis.dataSideVerdict || "").trim();
  const action = String(analysis.notificationAction || "").trim();
  if (verdict === "verified_normal" || analysis.chartVisibility === "hide_verified_normal") {
    return {
      className: "success ai-verdict-normal",
      supportClass: "ai-support-normal",
      title: "AI 分析后无异常",
      detail: analysis.verificationReason || "实时取证已确认该原始告警不属于当前数据异常，最终播报会跳过。",
    };
  }
  if (verdict === "business_change" || action === "downgrade") {
    return {
      className: "success ai-verdict-business",
      supportClass: "ai-support-business",
      title: "业务变化，不作为数据侧异常播报",
      detail: "AI 判断数据链路未发现故障证据，最终播报会跳过或降级。",
    };
  }
  if (verdict === "data_issue" || action === "send") {
    return {
      className: "error ai-verdict-issue",
      supportClass: "ai-support-issue",
      title: "有数据侧异常",
      detail: "AI 取证认为需要进入最终异常播报或人工处理。",
    };
  }
  return {
    className: "warn ai-verdict-unknown",
    supportClass: "ai-support-unknown",
    title: "证据不足，按异常保守处理",
    detail: "AI 未取得足够证据排除异常，最终播报会保留该项。",
  };
}


function renderMetabaseAnalysisList(label, items) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return "";
  return `<div class="anomaly-detail-reason"><span>${escapeHtml(label)}</span><ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

export function parseAnomalyMessage(message, anomalyType = "") {
  const text = String(message || "");
  const detail = {
    reason: "",
    metricName: "",
    currentValue: "",
    baselineValue: "",
    changeValue: "",
    timeText: "",
  };
  if (["queryError", "metabaseConfigError", "metabaseStalePublicLink"].includes(anomalyType)) {
    detail.reason = "查询异常";
  } else if (/缺少|没有|最新日期|必须存在|返回为空|无数据/.test(text)) {
    detail.reason = "数据缺失";
  } else if (anomalyType === "latestNonZeroToZero" || /波动|变化|从 .* (?:到|降为) /.test(text)) {
    detail.reason = "指标波动超阈值";
  }

  const fromTo = text.match(/从\s*([^，,\s（(]+)\s*(?:到|降为)\s*([^，,\s（(]+)/);
  if (fromTo) {
    detail.baselineValue = fromTo[1];
    detail.currentValue = fromTo[2];
  }

  const metricName = extractAnomalyMetricName(text);
  if (metricName) {
    detail.metricName = metricName;
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
  detail.dimensionText = extractAnomalyDimensionText(text);
  return detail;
}

function extractAnomalyMetricName(text) {
  const metricPatterns = [
    /(?:完整日指标|稳健完整日指标|同时间指标|上一日同时间点指标|指标)「([^」]+)」/,
    /(?:完整日指标|稳健完整日指标|同时间指标|上一日同时间点指标|指标)“([^”]+)”/,
    /(?:完整日指标|稳健完整日指标|同时间指标|上一日同时间点指标|指标)"([^"]+)"/,
  ];
  for (const pattern of metricPatterns) {
    const match = String(text || "").match(pattern);
    if (match) {
      return match[1];
    }
  }
  return "";
}

function extractAnomalyDimensionText(text) {
  const parenthesizedSections = [...String(text || "").matchAll(/[（(]([^（）()]+)[）)]/g)]
    .map((match) => match[1]);
  const dimensionParts = [];

  for (const section of parenthesizedSections) {
    for (const rawPart of section.split(/[，,]/)) {
      const part = rawPart.trim();
      if (!part.includes("=")) {
        continue;
      }
      if (/^(统计日期|stat_date|注册日期|到期日期|日期|时间|timezone)\s*=/.test(part)) {
        continue;
      }
      dimensionParts.push(part);
    }
  }

  return [...new Set(dimensionParts)].join("，");
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
  const dashboards = getDashboards({ executableOnly: true });
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
                <label class="kn-target-field">
                  群聊 chat_id
                  <input class="schedule-country-chat-id" value="${escapeHtml(config.chatId || "")}" placeholder="例如 -1001234567890">
                </label>
                <label class="tv-target-field">
                  TV bot_id
                  <input class="schedule-country-bot-id" value="${escapeHtml(config.botId || "")}" placeholder="TV bot_id">
                </label>
                <label class="tv-target-field">
                  TV 提醒人
                  <input class="schedule-country-mentions" value="${escapeHtml(config.mentions || "")}" placeholder="多个邮箱用逗号分隔">
                </label>
                <p class="kn-target-field muted-inline">可同时填写邮箱和群聊 chat_id：巡检结果会私聊每位接收人，并同步到群聊。</p>
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
  const notifyConfig = getBatchNotifyConfig();
  return {
    enabled: Boolean(root.querySelector("#batch-schedule-enabled")?.checked),
    includeDsScheduler: Boolean(root.querySelector("#batch-include-ds-scheduler")?.checked),
    includeHiveScheduler: Boolean(root.querySelector("#batch-include-hive-scheduler")?.checked),
    dailyRunTimes: parseDailyRunTimes(root.querySelector("#batch-schedule-daily-run-times")?.value || "09:00"),
    intervalMinutes: 1440,
    countryCode: scope.countryCode || "",
    dashboardUuid: scope.dashboardUuid || "",
    webhookUrl: notifyConfig.webhookUrl,
    botId: notifyConfig.botId,
    mentions: notifyConfig.mentions,
    countryConfigs: [...root.querySelectorAll(".schedule-country-row")].map((row) => buildBatchScheduleCountryConfig(row, notifyConfig)),
  };
}

export function buildBatchScheduleCountryConfig(row, notifyConfig = {}) {
  const notifyChannel = row.querySelector(".schedule-country-notify-channel")?.value || "knBot";
  return {
    countryCode: row.dataset.countryCode || "",
    enabled: Boolean(row.querySelector(".schedule-country-enabled")?.checked),
    dashboardUuids: [row.querySelector(".schedule-country-dashboard-uuid")?.value || ""].filter(Boolean),
    notifyChannel,
    webhookUrl: notifyConfig.webhookUrl || "",
    botId: notifyChannel === "tv" ? row.querySelector(".schedule-country-bot-id")?.value.trim() || "" : "",
    botToken: notifyChannel === "knBot" ? "${KN_BOT_TOKEN}" : "",
    chatId: notifyChannel === "knBot" ? row.querySelector(".schedule-country-chat-id")?.value.trim() || "" : "",
    recipientEmails: notifyChannel === "knBot" ? row.querySelector(".schedule-country-recipient-emails")?.value.trim() || "" : "",
    mentions: notifyChannel === "tv" ? row.querySelector(".schedule-country-mentions")?.value.trim() || "" : "",
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

function renderDashboardScanDetails(result, context = {}) {
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
              <th>异常波动</th>
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
                <td>${row.anomalyCount > 0 && context.runId ? `<button class="link-button compact-link" type="button" data-view-dashboard-fluctuations data-run-id="${escapeHtml(context.runId)}" data-country-code="${escapeHtml(context.countryCode || row.countryCode || "")}" data-dashboard-url="${escapeHtml(row.dashboardUrl || "")}" data-dashboard-title="${escapeHtml(row.dashboardTitle || "")}">打开</button>` : ""}</td>
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
    if (isExcludedScanDashboardRow(card)) {
      continue;
    }
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
        aiSuppressedCount: 0,
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
  for (const [anomalyIndex, anomaly] of (result.anomalies || []).entries()) {
    if (isExcludedScanDashboardRow(anomaly)) {
      continue;
    }
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
        aiSuppressedCount: 0,
        cards: [],
        anomalySamples: [],
      });
    }
    const group = groups.get(key);
    const audit = Array.isArray(result.aiAudit) ? result.aiAudit[anomalyIndex] : null;
    if (audit && audit.notifiable === false) {
      group.aiSuppressedCount += 1;
      continue;
    }
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
      : group.aiSuppressedCount > 0
        ? "AI分析后无异常"
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

function isExcludedScanDashboardRow(item = {}) {
  const title = String(item.dashboardTitle || item.sourcePanelTitle || item.title || "");
  const url = String(item.dashboardUrl || item.sourceUrl || item.url || "");
  return title.includes("营销过程数据统计")
    || /\/dashboard\/(?:993|994)(?:[/?#]|$)/.test(url);
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
  if (group.aiSuppressedCount > 0) {
    parts.push(`AI 已核验 ${group.aiSuppressedCount} 条原始异常无需最终播报`);
  }
  if (!parts.length) {
    return `无异常，已扫描 ${group.checkedCardCount || 0} 张卡片`;
  }
  return parts.join("；");
}

function summarizeAnomalySituation(anomaly) {
  const cardTitle = anomaly.cardTitle || "未命名卡片";
  const detail = parseAnomalyMessage(anomaly.message || "", anomaly.type);
  const pieces = [];
  if (detail.reason) {
    pieces.push(detail.reason);
  }
  if (detail.metricName) {
    pieces.push(`指标 ${detail.metricName}`);
  }
  if (detail.dimensionText) {
    pieces.push(detail.dimensionText);
  }
  if (["数据缺失", "查询异常"].includes(detail.reason) && anomaly.message) {
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

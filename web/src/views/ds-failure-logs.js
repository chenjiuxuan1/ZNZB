import { apiDelete, apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_OPTIONS = [
  { code: "cn", name: "中国", flag: "🇨🇳" },
  { code: "ine", name: "印尼", flag: "🇮🇩" },
  { code: "ph", name: "菲律宾", flag: "🇵🇭" },
  { code: "th", name: "泰国", flag: "🇹🇭" },
  { code: "pk", name: "巴基斯坦", flag: "🇵🇰" },
  { code: "mx", name: "墨西哥", flag: "🇲🇽" },
];
const COUNTRY_META = Object.fromEntries(COUNTRY_OPTIONS.map((item) => [item.code, item]));
const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const STATUS_LABELS = {
  recovered: { label: "已自动修复", className: "ok" },
  repairing: { label: "修复中", className: "warn" },
  unresolved: { label: "待修复", className: "danger" },
  retrying: { label: "自动重跑中", className: "warn" },
  running: { label: "重跑运行中", className: "warn" },
  retry_wait: { label: "等待继续重跑", className: "warn" },
  sql_code_error: { label: "SQL错误，需人工修改", className: "danger" },
  permission_error: { label: "权限不足，需人工处理", className: "danger" },
  suspected_empty_run: { label: "疑似空跑", className: "warn" },
  manual_review: { label: "待人工确认", className: "danger" },
  safety_stopped: { label: "已停止重跑", className: "danger" },
  sql_error: { label: "SQL错误，需人工修改", className: "danger" },
  recoverable: { label: "自动重跑中", className: "warn" },
};

let model = {
  activeTab: "today",
  result: null,
  loading: false,
  error: "",
  status: "",
  scheduleCategory: "",
  keyword: "",
  lookbackDays: 1,
  completed: 0,
  total: 0,
  runId: 0,
  countries: [],
  nextAutoRefreshAt: 0,
  retryControl: { enabled: false, startAt: null, activeCount: 0, logCount: 0 },
  retryCountries: COUNTRY_OPTIONS.map((item) => item.code),
  retryExcludedProjects: {},
  retryProjects: {},
  retryExclusionOpen: false,
  retryLogs: [],
  retryControlLoaded: false,
  retryActionLoading: false,
  retryManualActionLoading: false,
  retryActionMessage: "",
  pendingDeleteRunId: "",
  retryHistoryPage: 1,
  scheduledResult: null,
  scheduledLoading: false,
  scheduledCountries: [],
  scheduledKeyword: "",
  scheduledLookbackDays: 7,
  scheduledCountryPages: {},
  scheduledConfig: { enabled: true, intervalMinutes: 5, owners: {} },
  scheduledConfigLoaded: false,
  scheduledMessage: "",
};

let autoRefreshTimer = null;
let retryDetailPollTimer = null;
let queryController = null;

export function renderDsFailureLogs(root) {
  syncAutoRefresh(root);
  paint(root);
  if (!model.retryControlLoaded) refreshRetryPanel(root);
  if (!model.scheduledConfigLoaded) refreshScheduledConfig(root);
}

async function refreshScheduledConfig(root) {
  try {
    model.scheduledConfig = await apiGet("/api/ds-scheduled-failure-watch/config");
  } catch (error) {
    model.scheduledMessage = readableQueryError(error);
  } finally {
    model.scheduledConfigLoaded = true;
    if (isCurrentView()) paint(root);
  }
}

async function loadScheduledFailures(root) {
  if (model.scheduledLoading) return;
  const lookbackDays = normalizeUiLookbackDays(root.querySelector("#ds-scheduled-lookback-days")?.value, 7);
  model.scheduledLookbackDays = lookbackDays;
  const selected = COUNTRY_OPTIONS.filter((item) => !model.scheduledCountries.length || model.scheduledCountries.includes(item.code));
  model.scheduledLoading = true;
  model.scheduledCountryPages = {};
  model.scheduledMessage = "";
  model.scheduledResult = aggregateResult(selected.map(queryingCountry));
  paint(root);
  try {
    const response = await apiGet(`/api/ds-scheduled-failure-watch?country=${encodeURIComponent(selected.map((item) => item.code).join(","))}&days=${lookbackDays}`);
    model.scheduledResult = aggregateResult(response.countries || []);
    if (response.notificationErrors?.length) model.scheduledMessage = response.notificationErrors.join("；");
  } catch (error) {
    model.scheduledResult = aggregateResult(selected.map((option) => failedCountry(option, readableQueryError(error))));
  }
  model.scheduledLoading = false;
  if (isCurrentView()) paint(root);
}

async function saveScheduledOwners(root) {
  const owners = {};
  for (const option of COUNTRY_OPTIONS) owners[option.code] = root.querySelector(`[data-scheduled-owner="${option.code}"]`)?.value || "";
  try {
    model.scheduledConfig = await apiPut("/api/ds-scheduled-failure-watch/config", { ...model.scheduledConfig, owners });
    model.scheduledMessage = "负责人邮箱已保存，将同时用于 n8n 失败重启监控和定时失败任务重跑通知。";
  } catch (error) {
    model.scheduledMessage = `负责人配置保存失败：${error.message}`;
  }
  paint(root);
}

async function refreshRetryPanel(root) {
  try {
    const [control, logResult, schedulerConfig] = await Promise.all([
      apiGet("/api/ds-failure-retry/control"),
      apiGet("/api/ds-failure-retry/logs?limit=200"),
      apiGet("/api/ds-scheduler/config"),
    ]);
    model.retryControl = control;
    model.retryCountries = Array.isArray(control.countries) && control.countries.length
      ? [...control.countries]
      : COUNTRY_OPTIONS.map((item) => item.code);
    model.retryExcludedProjects = control.excludedProjects && typeof control.excludedProjects === "object" ? control.excludedProjects : {};
    model.retryProjects = schedulerConfig.projects && typeof schedulerConfig.projects === "object" ? schedulerConfig.projects : {};
    model.retryLogs = logResult.logs || [];
    model.retryControlLoaded = true;
    if (isCurrentView()) paint(root);
  } catch (error) {
    model.retryControlLoaded = true;
    model.retryActionMessage = readableQueryError(error);
    if (isCurrentView()) paint(root);
  }
}

async function toggleRetry(root) {
  if (model.retryActionLoading) return;
  const enabling = !model.retryControl.enabled;
  const selectedIntervalMinutes = enabling
    ? Number(root.querySelector("#ds-retry-interval")?.value || 0)
    : Number(model.retryControl.intervalMinutes || 60);
  const selectedRetryMinute = enabling
    ? Number(root.querySelector("#ds-retry-minute")?.value)
    : Number(model.retryControl.retryMinute || 0);
  if (enabling && (!Number.isFinite(selectedIntervalMinutes) || selectedIntervalMinutes < 1)) {
    model.retryActionMessage = "重跑间隔至少为 1 分钟";
    paint(root);
    return;
  }
  if (enabling && (!Number.isInteger(selectedRetryMinute) || selectedRetryMinute < 0 || selectedRetryMinute > 59)) {
    model.retryActionMessage = "自动重跑分钟必须是 0 到 59 的整数";
    paint(root);
    return;
  }
  model.retryActionLoading = true;
  model.retryActionMessage = "";
  paint(root);
  try {
    if (model.retryControl.enabled) {
      model.retryControl = await apiPost("/api/ds-failure-retry/stop");
      model.retryActionMessage = "已停止自动重跑；正在运行的任务将在下一次状态检查时退出。";
    } else {
      model.retryControl = await apiPost("/api/ds-failure-retry/start", {
        countries: model.retryCountries,
        excludedProjects: model.retryExcludedProjects,
        intervalMinutes: selectedIntervalMinutes,
        retryMinute: selectedRetryMinute,
      });
      model.retryActionMessage = `自动重跑已开启；首次运行 ${formatTime(model.retryControl.nextRunAt)}，之后每隔 ${selectedIntervalMinutes / 60} 小时执行一次。`;
    }
    const logResult = await apiGet("/api/ds-failure-retry/logs?limit=200");
    model.retryLogs = logResult.logs || [];
  } catch (error) {
    model.retryActionMessage = String(error?.message || error);
  } finally {
    model.retryActionLoading = false;
    if (isCurrentView()) paint(root);
  }
}

async function runRetryNow(root) {
  if (model.retryManualActionLoading) return;
  model.retryManualActionLoading = true;
  model.retryActionMessage = model.retryControl.manualRunning ? "正在停止立即运行测试…" : "正在立即执行重跑检查…";
  paint(root);
  try {
    if (model.retryControl.manualRunning) {
      model.retryControl = await apiPost("/api/ds-failure-retry/run-now/stop", {});
      model.retryActionMessage = "已停止立即运行测试；自动重跑开关未改变。";
    } else {
      model.retryControl = await apiPost("/api/ds-failure-retry/run-now", {
        countries: model.retryCountries,
        excludedProjects: model.retryExcludedProjects,
      });
      model.retryActionMessage = "已开始立即运行测试；再次点击可停止，自动重跑开关未改变。";
    }
    const logResult = await apiGet("/api/ds-failure-retry/logs?limit=200");
    model.retryLogs = logResult.logs || [];
  } catch (error) {
    model.retryActionMessage = `立即重跑失败：${error.message}`;
  } finally {
    model.retryManualActionLoading = false;
    paint(root);
    scheduleManualStatusPoll(root);
  }
}

function scheduleManualStatusPoll(root) {
  if (!model.retryControl.manualRunning) return;
  setTimeout(async () => {
    if (!isCurrentView()) return;
    try {
      const wasRunning = Boolean(model.retryControl.manualRunning);
      model.retryControl = await apiGet("/api/ds-failure-retry/control");
      if (wasRunning && !model.retryControl.manualRunning) {
        const logResult = await apiGet("/api/ds-failure-retry/logs?limit=200");
        model.retryLogs = logResult.logs || [];
      }
      paint(root);
      scheduleManualStatusPoll(root);
    } catch {}
  }, 1000);
}

async function saveRetryExclusions(root) {
  const excludedProjects = {};
  for (const option of COUNTRY_OPTIONS) {
    excludedProjects[option.code] = [...root.querySelectorAll(`[data-retry-project-country="${option.code}"]:checked`)]
      .map((item) => item.value).filter(Boolean);
  }
  model.retryActionLoading = true;
  try {
    model.retryControl = await apiPost("/api/ds-failure-retry/config", { excludedProjects });
    model.retryExcludedProjects = model.retryControl.excludedProjects || excludedProjects;
    model.retryExclusionOpen = false;
    model.retryActionMessage = "不重跑项目配置已保存。";
  } catch (error) {
    model.retryActionMessage = `不重跑项目配置保存失败：${error.message}`;
  } finally {
    model.retryActionLoading = false;
    paint(root);
  }
}

async function saveRetryCountries(root, values) {
  model.retryCountries = values;
  if (!model.retryControl.enabled) return;
  try {
    model.retryControl = await apiPost("/api/ds-failure-retry/config", {
      countries: values,
      excludedProjects: model.retryExcludedProjects,
    });
    model.retryActionMessage = "重跑国家已更新，将从下一轮自动重跑开始生效。";
  } catch (error) {
    model.retryActionMessage = `重跑国家更新失败：${error.message}`;
  }
  paint(root);
}

async function load(root) {
  if (model.loading) return;
  clearAutoRefresh();
  const lookbackDays = normalizeUiLookbackDays(root.querySelector("#ds-failure-lookback-days")?.value, 1);
  model.lookbackDays = lookbackDays;
  const selected = COUNTRY_OPTIONS.filter((item) => !model.countries.length || model.countries.includes(item.code));

  const runId = ++model.runId;
  model.loading = true;
  model.error = "";
  model.completed = 0;
  model.total = selected.length;
  queryController = new AbortController();
  const signal = queryController.signal;
  model.result = aggregateResult(selected.map(queryingCountry));
  paint(root);

  await Promise.all(selected.map(async (option) => {
    let country;
    try {
      const response = await apiGet(`/api/ds-failure-logs?country=${encodeURIComponent(option.code)}&days=${lookbackDays}`, { signal });
      country = response.countries?.[0] || failedCountry(option, "接口未返回该国家的检查结果");
    } catch (error) {
      country = failedCountry(option, readableQueryError(error));
    }
    if (runId !== model.runId) return;
    const countries = (model.result?.countries || []).map((item) => item.country === option.code ? country : item);
    model.completed += 1;
    model.result = aggregateResult(countries);
    if (isCurrentView()) paint(root);
  }));

  if (runId !== model.runId) return;
  model.loading = false;
  queryController = null;
  if (isCurrentView()) {
    syncAutoRefresh(root);
    paint(root);
  }
}

function stopQuery(root) {
  if (!model.loading) return;
  model.runId += 1;
  queryController?.abort();
  queryController = null;
  model.loading = false;
  model.result = aggregateResult((model.result?.countries || []).map((country) => country.querying
    ? failedCountry(COUNTRY_META[country.country] || { code: country.country, name: country.country }, "已手动停止查询")
    : country));
  syncAutoRefresh(root);
  paint(root);
}

function unresolvedFailureCount() {
  return (model.result?.countries || [])
    .filter((country) => !model.countries.length || model.countries.includes(country.country))
    .flatMap((country) => country.failures || [])
    .filter((item) => item.repairStatus === "unresolved").length;
}

function clearAutoRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = null;
  model.nextAutoRefreshAt = 0;
}

function syncAutoRefresh(root) {
  if (!isCurrentView() || model.loading || unresolvedFailureCount() === 0) {
    clearAutoRefresh();
    return;
  }
  if (autoRefreshTimer) return;
  model.nextAutoRefreshAt = Date.now() + AUTO_REFRESH_INTERVAL_MS;
  autoRefreshTimer = setTimeout(() => {
    autoRefreshTimer = null;
    model.nextAutoRefreshAt = 0;
    if (isCurrentView() && !model.loading) load(root);
  }, AUTO_REFRESH_INTERVAL_MS);
}

function readableQueryError(error) {
  const message = String(error?.message || "查询失败");
  if (/failed to fetch/i.test(message)) return "平台未收到服务器响应，可能是查询超时、服务重启或 DS 网关连接中断";
  if (/timeout|timed out/i.test(message)) return "DS 网关或目标国家响应超时";
  return message;
}

function queryingCountry(option) {
  return {
    country: option.code,
    countryName: option.name,
    querying: true,
    configured: true,
    success: false,
    failures: [],
    projects: [],
    checkedProjects: 0,
    checkedInstances: 0,
  };
}

function failedCountry(option, message) {
  return {
    country: option.code,
    countryName: option.name,
    queryFailed: true,
    configured: true,
    success: false,
    error: message || "查询失败",
    failures: [],
    projects: [],
    checkedProjects: 0,
    checkedInstances: 0,
  };
}

function aggregateResult(countries) {
  const completedCountries = countries.filter((item) => !item.querying);
  const failures = completedCountries.flatMap((item) => item.failures || []);
  return {
    checkedAt: new Date().toISOString(),
    dateMode: "country-local-today",
    totalCountries: countries.length,
    configuredCountries: completedCountries.filter((item) => item.configured).length,
    checkedProjects: completedCountries.reduce((sum, item) => sum + Number(item.checkedProjects || 0), 0),
    checkedInstances: completedCountries.reduce((sum, item) => sum + Number(item.checkedInstances || 0), 0),
    totalFailures: failures.length,
    recoveredCount: failures.filter((item) => item.repairStatus === "recovered").length,
    repairingCount: failures.filter((item) => item.repairStatus === "repairing").length,
    unresolvedCount: failures.filter((item) => item.repairStatus === "unresolved").length,
    failedCountries: completedCountries.filter((item) => item.configured && !item.success).length,
    countries,
  };
}

function isCurrentView() {
  if (typeof window === "undefined") return true;
  return window.location.hash.replace(/^#/, "").split("?")[0] === "/ds-failure-logs";
}

function paint(root) {
  const retryRunId = retryHistoryRunId();
  if (retryRunId) {
    renderRetryHistoryDetailPage(root, retryRunId);
    return;
  }
  clearTimeout(retryDetailPollTimer);
  retryDetailPollTimer = null;
  const result = model.result
    ? aggregateResult(model.result.countries.filter((item) => !model.countries.length || model.countries.includes(item.country)))
    : {};
  const hasResult = Boolean(model.result);
  const selectedCount = model.countries.length || COUNTRY_OPTIONS.length;
  const autoRefreshNotice = model.nextAutoRefreshAt
    ? `<div class="sandbox-status warn"><strong>待修复任务自动复查</strong><span>页面将每隔 1 小时自动重新查询当前国家；下次复查时间：${formatTime(model.nextAutoRefreshAt)}</span></div>`
    : "";
  const retryStateLabel = model.retryControl.enabled
    ? "自动重跑已启用"
    : "自动重跑已关闭";
  root.innerHTML = `
    <div class="page-header batch-hero ds-failure-hero">
      <div>
        <h1 class="page-title">DS 失败任务日志</h1>
        <p class="page-note">按国家查询当天失败实例；选择全部国家时，各国并行查询并在完成后立即显示。</p>
      </div>
      <div class="hero-stats">
        ${stat("查询进度", model.loading ? `${model.completed} / ${model.total}` : hasResult ? `${result.totalCountries || 0} / ${selectedCount}` : "—")}
        ${stat("失败任务", hasResult ? result.totalFailures || 0 : "—")}
        ${stat("已自动修复", hasResult ? result.recoveredCount || 0 : "—")}
        ${stat("修复中 / 待修复", hasResult ? `${result.repairingCount || 0} / ${result.unresolvedCount || 0}` : "—")}
      </div>
    </div>
    <div class="workspace-tabs ds-failure-page-tabs" role="tablist">
      <button class="${model.activeTab === "today" ? "active" : ""}" data-ds-failure-tab="today"><small>01</small><strong>当天失败任务</strong><span>查询当天全部失败实例</span></button>
      <button class="${model.activeTab === "retry" ? "active" : ""}" data-ds-failure-tab="retry"><small>02</small><strong>定时失败任务重跑</strong><span>手动测试、定时重跑与历史</span></button>
      <button class="${model.activeTab === "scheduled" ? "active" : ""}" data-ds-failure-tab="scheduled"><small>03</small><strong>n8n失败重启监控</strong><span>按自定义天数查看 n8n 失败重启任务</span></button>
    </div>
    ${model.error ? `<div class="sandbox-status error"><strong>无法查询</strong><span>${escapeHtml(model.error)}</span></div>` : ""}
    <section class="panel ds-failure-toolbar" ${model.activeTab === "today" ? "" : 'style="display:none"'}>
      ${autoRefreshNotice}
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">当天失败任务</h2><p class="muted">选择需要观察的国家后点击查询。每个国家独立返回，查询中的国家不会阻塞已完成国家的结果。</p></div>
        <div class="ds-retry-header-actions"><button class="primary" id="ds-failure-query" ${model.loading ? "disabled" : ""}>${model.loading ? `正在查询 ${model.completed}/${model.total}` : hasResult ? "重新查询" : "查询"}</button>${model.loading ? '<button class="secondary" id="ds-failure-stop-query">停止查询</button>' : ""}</div>
      </div>
      <div class="ds-failure-filter-grid">
        ${renderCountryMultiSelect("ds-failure-country", "国家", model.countries, model.loading)}
        <label>查询最近几天<input id="ds-failure-lookback-days" type="number" min="1" max="90" step="1" value="${model.lookbackDays}" ${model.loading ? "disabled" : ""} placeholder="1-90"></label>
        <label>修复状态<select id="ds-failure-status"><option value="">全部状态</option>${Object.entries(STATUS_LABELS).map(([value, item]) => `<option value="${value}" ${model.status === value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
        <label>定时状态<select id="ds-failure-schedule-category"><option value="">全部任务</option><option value="scheduled_online" ${model.scheduleCategory === "scheduled_online" ? "selected" : ""}>定时上线任务</option><option value="non_scheduled_online" ${model.scheduleCategory === "non_scheduled_online" ? "selected" : ""}>非定时上线任务</option></select></label>
        <label>搜索项目或任务<input id="ds-failure-keyword" value="${escapeHtml(model.keyword)}" placeholder="项目、工作流、失败任务或原因"></label>
      </div>
      <div class="ds-failure-legend"><span class="badge ok">已自动修复</span><span>最新失败实例后出现成功实例</span><span class="badge warn">修复中</span><span>最新失败实例后出现运行中实例</span><span class="badge danger">待修复</span><span>最新失败实例后没有成功或运行中实例</span></div>
    </section>
    ${renderScheduledFailureWatch()}
    <section class="panel ds-failure-retry-control" ${model.activeTab === "retry" ? "" : 'style="display:none"'}>
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">定时失败任务重跑</h2><p class="muted">除 SQL/代码错误和权限不足外，其余失败每轮最多提交一次重跑；提交后仅检查修复结果，人工停止、下线及跨天任务仍会安全停止。</p></div>
        <div class="ds-retry-header-actions ds-retry-control-actions">
          <button class="secondary ds-retry-action" id="ds-retry-refresh-logs" ${model.retryActionLoading ? "disabled" : ""}>刷新日志</button>
          <button class="secondary ds-retry-action" id="ds-retry-exclusions">不重跑项目配置</button>
          <button class="green-toggle" id="ds-retry-run-now" type="button" role="switch" aria-checked="${Boolean(model.retryControl.manualRunning)}" ${model.retryManualActionLoading ? "disabled" : ""}><span class="green-toggle-track"></span><span>${model.retryManualActionLoading ? "处理中…" : model.retryControl.manualRunning ? "停止立即测试" : "立即运行测试"}</span></button>
        </div>
      </div>
      <div class="ds-failure-filter-grid">
        ${renderRetryIntervalSelect(model.retryControl.intervalMinutes || 60, model.retryControl.enabled)}
        <label>自动重跑分钟<input id="ds-retry-minute" type="number" min="0" max="59" step="1" value="${Number(model.retryControl.retryMinute ?? 0)}" ${model.retryControl.enabled ? "disabled" : ""} placeholder="0-59"></label>
        ${renderCountryMultiSelect("ds-retry-country", "重跑国家", model.retryCountries, false)}
        <div class="country-multi-field"><span>自动重跑</span><button class="green-toggle ds-retry-run-now" id="ds-retry-toggle" type="button" role="switch" aria-checked="${model.retryControl.enabled}" ${model.retryActionLoading ? "disabled" : ""}><span class="green-toggle-track"></span><span>${model.retryActionLoading ? "处理中…" : retryStateLabel}</span></button><small>开启后在所设置的重跑分钟执行第一轮，之后按所选间隔运行</small></div>
        <label>当前运行任务<input value="${Number(model.retryControl.activeCount || 0)} 个" disabled></label>
      </div>
      <div class="schedule-overview ds-retry-schedule-times">
        <div class="info-item"><span>下次运行</span><strong>${escapeHtml(formatScheduleTime(model.retryControl.nextRunAt))}</strong></div>
        <div class="info-item"><span>上次运行</span><strong>${escapeHtml(formatScheduleTime(model.retryControl.lastRunAt))}</strong></div>
      </div>
      ${model.retryActionMessage ? `<div class="sandbox-status ${/失败|错误|无效|请选择/.test(model.retryActionMessage) ? "error" : "warn"}"><span>${escapeHtml(model.retryActionMessage)}</span></div>` : ""}
      <div class="sub-panel ds-retry-history">
        <div class="detail-header compact-header">
          <div><h3 class="panel-title">重跑历史</h3><p class="muted">每次启动形成一条历史记录，点击“打开详情页”查看该次重跑的完整过程。</p></div>
        </div>
        ${renderRetryHistoryRows(buildRetryRuns(model.retryLogs), model.retryHistoryPage)}
      </div>
    </section>
    ${renderRetryExclusionModal()}
    <section class="ds-failure-country-list" ${model.activeTab === "today" ? "" : 'style="display:none"'}>
      ${hasResult ? renderCountries(result.countries || []) : `<section class="panel ds-failure-empty"><strong>尚未查询</strong><p class="muted">选择需要观察的国家，然后点击“查询”。</p></section>`}
    </section>
  `;

  root.querySelectorAll("[data-ds-failure-tab]").forEach((button) => button.addEventListener("click", () => {
    model.activeTab = button.dataset.dsFailureTab;
    paint(root);
  }));

  root.querySelector("#ds-failure-query")?.addEventListener("click", () => load(root));
  root.querySelector("#ds-failure-stop-query")?.addEventListener("click", () => stopQuery(root));
  bindCountryMultiSelect(root, "ds-failure-country", (values) => { model.countries = values; });
  root.querySelector("#ds-failure-lookback-days")?.addEventListener("input", (event) => { model.lookbackDays = normalizeUiLookbackDays(event.target.value, 1); });
  root.querySelector("#ds-failure-status")?.addEventListener("change", (event) => { model.status = event.target.value; paint(root); });
  root.querySelector("#ds-failure-schedule-category")?.addEventListener("change", (event) => { model.scheduleCategory = event.target.value; paint(root); });
  root.querySelector("#ds-failure-keyword")?.addEventListener("input", (event) => { model.keyword = event.target.value; paint(root); root.querySelector("#ds-failure-keyword")?.focus(); });
  root.querySelector("#ds-retry-toggle")?.addEventListener("click", () => toggleRetry(root));
  root.querySelector("#ds-retry-refresh-logs")?.addEventListener("click", () => refreshRetryPanel(root));
  root.querySelector("#ds-retry-run-now")?.addEventListener("click", () => runRetryNow(root));
  root.querySelector("#ds-retry-exclusions")?.addEventListener("click", () => { model.retryExclusionOpen = true; paint(root); });
  root.querySelector("#ds-retry-exclusion-close")?.addEventListener("click", () => { model.retryExclusionOpen = false; paint(root); });
  root.querySelector("#ds-retry-exclusion-cancel")?.addEventListener("click", () => { model.retryExclusionOpen = false; paint(root); });
  root.querySelector("#ds-retry-exclusion-save")?.addEventListener("click", () => saveRetryExclusions(root));
  root.querySelectorAll("[data-delete-retry-run]").forEach((button) => button.addEventListener("click", () => deleteRetryRun(root, button.dataset.deleteRetryRun)));
  root.querySelectorAll("[data-confirm-delete-retry-run]").forEach((button) => button.addEventListener("click", () => confirmDeleteRetryRun(root, button.dataset.confirmDeleteRetryRun)));
  root.querySelectorAll("[data-cancel-delete-retry-run]").forEach((button) => button.addEventListener("click", () => { model.pendingDeleteRunId = ""; paint(root); }));
  root.querySelectorAll("[data-retry-history-page]").forEach((button) => button.addEventListener("click", () => {
    model.retryHistoryPage = Number(button.dataset.retryHistoryPage) || 1;
    model.pendingDeleteRunId = "";
    paint(root);
  }));
  const retryHistoryJump = root.querySelector("#ds-retry-history-jump");
  const jumpRetryHistoryPage = () => {
    const target = Number(retryHistoryJump?.value);
    if (!Number.isInteger(target) || target < 1) return;
    model.retryHistoryPage = target;
    model.pendingDeleteRunId = "";
    paint(root);
  };
  retryHistoryJump?.addEventListener("change", jumpRetryHistoryPage);
  retryHistoryJump?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") jumpRetryHistoryPage();
  });
  bindCountryMultiSelect(root, "ds-retry-country", (values) => { void saveRetryCountries(root, values); });
  bindCountryMultiSelect(root, "ds-scheduled-country", (values) => { model.scheduledCountries = values; });
  root.querySelector("#ds-scheduled-lookback-days")?.addEventListener("input", (event) => { model.scheduledLookbackDays = normalizeUiLookbackDays(event.target.value, 7); });
  root.querySelector("#ds-scheduled-query")?.addEventListener("click", () => loadScheduledFailures(root));
  root.querySelector("#ds-scheduled-keyword")?.addEventListener("input", (event) => { model.scheduledKeyword = event.target.value; model.scheduledCountryPages = {}; paint(root); root.querySelector("#ds-scheduled-keyword")?.focus(); });
  root.querySelector("#ds-scheduled-owner-save")?.addEventListener("click", () => saveScheduledOwners(root));
  root.querySelectorAll("[data-scheduled-country-page]").forEach((button) => button.addEventListener("click", () => {
    const country = String(button.dataset.scheduledCountry || "");
    const page = Number(button.dataset.scheduledCountryPage) || 1;
    if (!country) return;
    model.scheduledCountryPages = { ...model.scheduledCountryPages, [country]: page };
    paint(root);
  }));
}

function renderScheduledFailureWatch() {
  const result = model.scheduledResult || {};
  const owners = model.scheduledConfig.owners || {};
  return `<section class="ds-scheduled-failure-watch" ${model.activeTab === "scheduled" ? "" : 'style="display:none"'}>
    <section class="panel ds-failure-toolbar">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">n8n失败重启监控</h2><p class="muted">采用 Global-Intelligent-Alarm-Repair-Assistant 的处理口径：忽略重跑产生的二次告警，仅可恢复故障最多重跑 3 次并观察 30 分钟；SQL/代码错误和未知故障转人工处理。</p></div>
        <button class="primary" id="ds-scheduled-query" ${model.scheduledLoading ? "disabled" : ""}>${model.scheduledLoading ? "正在查询…" : model.scheduledResult ? "重新查询" : "查询"}</button>
      </div>
      <div class="ds-failure-filter-grid ds-scheduled-filter-grid">
        ${renderCountryMultiSelect("ds-scheduled-country", "国家", model.scheduledCountries, model.scheduledLoading)}
        <label>查询最近几天<input id="ds-scheduled-lookback-days" type="number" min="1" max="90" step="1" value="${model.scheduledLookbackDays}" ${model.scheduledLoading ? "disabled" : ""} placeholder="1-90"></label>
        <label>搜索项目或任务<input id="ds-scheduled-keyword" value="${escapeHtml(model.scheduledKeyword)}" placeholder="项目、工作流、失败任务或原因"></label>
      </div>
      ${model.scheduledMessage ? `<div class="sandbox-status ${/失败|错误/.test(model.scheduledMessage) ? "error" : "warn"}"><span>${escapeHtml(model.scheduledMessage)}</span></div>` : ""}
    </section>
    <section class="panel ds-scheduled-owner-panel">
      <div class="detail-header compact-header"><div><h3 class="panel-title">两个重跑模块共用负责人配置</h3><p class="muted">负责人同时接收 n8n 失败重启监控和定时失败任务重跑的对应国家通知；多个邮箱请用逗号分隔。</p></div><button class="primary" id="ds-scheduled-owner-save">保存负责人</button></div>
      <div class="ds-scheduled-owner-grid">${COUNTRY_OPTIONS.map((option) => `<label><span>${option.flag} ${option.name}</span><input data-scheduled-owner="${option.code}" value="${escapeHtml(owners[option.code] || "")}" placeholder="负责人邮箱，多个用逗号分隔"></label>`).join("")}</div>
    </section>
    <section class="ds-failure-country-list">${model.scheduledResult ? renderScheduledCountries(result.countries || []) : `<section class="panel ds-failure-empty"><strong>尚未查询</strong><p class="muted">后台会持续监控并通知；也可选择国家后手动查询当前结果。</p></section>`}</section>
  </section>`;
}

function renderRetryIntervalSelect(value, disabled) {
  const selected = Number(value) || 60;
  const options = [60, 120, 240, 360];
  if (!options.includes(selected)) options.push(selected);
  options.sort((a, b) => a - b);
  return `<label>自动重跑间隔<select id="ds-retry-interval" ${disabled ? "disabled" : ""}>${options.map((minutes) => `<option value="${minutes}" ${minutes === selected ? "selected" : ""}>每隔 ${minutes / 60} 小时</option>`).join("")}</select></label>`;
}

function renderRetryExclusionModal() {
  if (!model.retryExclusionOpen) return "";
  return `<div class="modal-backdrop ds-retry-exclusion-backdrop">
    <section class="panel ds-retry-exclusion-modal" role="dialog" aria-modal="true" aria-labelledby="ds-retry-exclusion-title">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title" id="ds-retry-exclusion-title">不重跑项目配置</h2><p class="muted">在六个国家模块中选择不参与重跑的项目。默认不选择；选中一个项目后，该项目下所有工作流都不会进入自动重跑。</p></div>
        <button class="secondary" id="ds-retry-exclusion-close" type="button">关闭</button>
      </div>
      <div class="schedule-country-grid ds-project-grid ds-retry-exclusion-grid">
        ${COUNTRY_OPTIONS.map((option) => renderRetryProjectCard(option)).join("")}
      </div>
      <div class="button-group ds-retry-exclusion-actions"><button class="secondary" id="ds-retry-exclusion-cancel" type="button">取消</button><button class="primary" id="ds-retry-exclusion-save" type="button">保存配置</button></div>
    </section>
  </div>`;
}

function renderRetryProjectCard(option) {
  const projects = Array.isArray(model.retryProjects[option.code]) ? model.retryProjects[option.code] : [];
  const excluded = model.retryExcludedProjects[option.code] || [];
  const selectedNames = projects.filter((project) => excluded.includes(String(project.code || project.name || ""))).map((project) => project.name || project.code);
  const summary = selectedNames.length ? `已选择 ${selectedNames.length} 个项目` : "未选择项目";
  return `<article class="schedule-country-card ds-project-card"><div class="schedule-country-card-header"><strong>${option.flag} ${option.name}</strong><span class="badge ${excluded.length ? "warn" : "ok"}">${excluded.length} 个项目不重跑</span></div>${projects.length ? `<div class="country-multi-field ds-retry-project-filter"><span>不重跑项目</span><details class="country-multi-select"><summary>${escapeHtml(summary)}</summary><div class="country-multi-menu ds-retry-project-menu">${projects.map((project) => {
    const identity = String(project.code || project.name || "");
    return `<label><input type="checkbox" data-retry-project-country="${option.code}" value="${escapeHtml(identity)}" ${excluded.includes(identity) ? "checked" : ""}><span>${escapeHtml(project.name || project.code || "未命名项目")}</span></label>`;
  }).join("")}</div></details></div>` : '<span class="muted ds-retry-project-empty">该国家尚未配置 DS 项目</span>'}</article>`;
}

function renderCountryMultiSelect(id, label, selected, disabled = false) {
  const names = COUNTRY_OPTIONS.filter((item) => selected.includes(item.code)).map((item) => item.name);
  const summary = names.length ? names.join("、") : "全部国家";
  return `<div class="country-multi-field"><span>${label}</span><details class="country-multi-select" id="${id}" ${disabled ? "data-disabled=true" : ""}><summary>${escapeHtml(summary)}</summary><div class="country-multi-menu">${COUNTRY_OPTIONS.map((item) => `<label><input type="checkbox" value="${item.code}" ${selected.includes(item.code) ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${item.flag} ${item.name}</span></label>`).join("")}</div></details></div>`;
}

function bindCountryMultiSelect(root, id, onChange) {
  const field = root.querySelector(`#${id}`);
  if (!field || field.dataset.disabled === "true") return;
  field.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener("change", () => {
    const values = [...field.querySelectorAll('input[type="checkbox"]:checked')].map((item) => item.value);
    onChange(values);
    const names = COUNTRY_OPTIONS.filter((item) => values.includes(item.code)).map((item) => item.name);
    const summary = field.querySelector("summary");
    if (summary) summary.textContent = names.length ? names.join("、") : "全部国家";
  }));
}

function renderRetryHistoryRows(runs, requestedPage = 1) {
  if (!runs.length) return `<p class="muted">暂无重跑历史。启动一次重跑计划后，这里会生成一条可打开详情页的历史记录。</p>`;
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(runs.length / pageSize));
  const page = Math.max(1, Math.min(pageCount, Number(requestedPage) || 1));
  if (model.retryHistoryPage !== page) model.retryHistoryPage = page;
  const pageRuns = runs.slice((page - 1) * pageSize, page * pageSize);
  return `
    <div class="table-wrap schedule-history-table ds-retry-history-table">
      <table>
        <thead><tr><th>运行时间</th><th>状态</th><th>国家</th><th>任务</th><th>重跑次数</th><th>结果</th><th>明细</th><th>删除</th></tr></thead>
        <tbody>${pageRuns.map((run) => `
          <tr>
            <td>${escapeHtml(formatTime(run.startedAt))}</td>
            <td><span class="badge ${retryRunBadge(run.status)}">${escapeHtml(retryRunStatus(run.status))}</span></td>
            <td>${escapeHtml(run.countryNames)}</td>
            <td>${run.taskCount} 个</td>
            <td>${run.retryCount}</td>
            <td>${escapeHtml(run.summary)}</td>
            <td><a class="link-button" href="#/ds-failure-logs?retryRunId=${encodeURIComponent(run.id)}">打开详情页</a></td>
            <td><div class="ds-retry-delete-wrap"><button class="icon-button danger-icon" type="button" data-delete-retry-run="${escapeHtml(run.id)}" title="删除这条重跑历史" aria-label="删除这条重跑历史"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6.5 7l.8 13h9.4l.8-13M10 11v5M14 11v5"/></svg></button>${model.pendingDeleteRunId === run.id ? `<div class="ds-retry-delete-confirm"><span>确定删除这条记录？</span><div><button class="secondary" type="button" data-cancel-delete-retry-run="${escapeHtml(run.id)}">取消</button><button class="primary" type="button" data-confirm-delete-retry-run="${escapeHtml(run.id)}">确认</button></div></div>` : ""}</div></td>
          </tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="ds-retry-history-pagination">
      <span>总条目为: ${runs.length}</span>
      <button class="ds-pagination-arrow" type="button" data-retry-history-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="上一页">‹</button>
      ${retryPaginationItems(page, pageCount).map((item) => item === "…"
        ? `<span class="ds-pagination-ellipsis">…</span>`
        : `<button class="ds-pagination-page ${item === page ? "active" : ""}" type="button" data-retry-history-page="${item}">${item}</button>`).join("")}
      <button class="ds-pagination-arrow" type="button" data-retry-history-page="${page + 1}" ${page >= pageCount ? "disabled" : ""} aria-label="下一页">›</button>
      <select class="ds-pagination-size" aria-label="每页条数"><option value="10">10 / 页</option></select>
      <label class="ds-pagination-jump">跳至<input id="ds-retry-history-jump" type="number" min="1" max="${pageCount}" value="${page}"></label>
    </div>`;
}

function retryPaginationItems(page, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set([1, pageCount, page - 1, page, page + 1].filter((item) => item >= 1 && item <= pageCount));
  const ordered = [...pages].sort((a, b) => a - b);
  const result = [];
  for (const number of ordered) {
    if (result.length && number - result.at(-1) > 1) result.push("…");
    result.push(number);
  }
  return result;
}

function buildRetryRuns(logs) {
  const groups = new Map();
  for (const item of logs) {
    const id = item.runId || `legacy-${item.id}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  return [...groups.entries()].map(([id, items]) => {
    const ordered = [...items].sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
    // Excluded projects are outside both manual-test and scheduled-retry scope.
    // Keep their audit events in the backend log, but omit them from user-facing
    // retry history and from all matched-task/country counters.
    const historyLogs = ordered.filter((item) => item.event !== "excluded");
    const countries = [...new Set(historyLogs.map((item) => item.country).filter(Boolean))];
    const controlLog = historyLogs.find((item) => Array.isArray(item.countries)) || {};
    const selectedCountries = Array.isArray(controlLog.countries) ? controlLog.countries : [];
    const selectedCountryNames = selectedCountries.map((country) => COUNTRY_META[country]?.name || country).join("、");
    const matchedCountryNames = countries.map((country) => COUNTRY_META[country]?.name || country).join("、");
    const taskCount = new Set(historyLogs.map((item) => item.key).filter(Boolean)).size;
    const retryCount = historyLogs.filter((item) => item.event === "retry_submitted").length;
    const status = historyLogs.some((item) => ["retry_failed", "retry_not_recovered", "configuration_error", "instance_check_failed", "workflow_check_failed"].includes(item.event)) ? "failed"
      : historyLogs.some((item) => ["manual_run_completed", "scheduled_run_completed"].includes(item.event)) ? "success"
        : historyLogs.some((item) => ["control_disabled", "manual_run_stopped", "safety_stopped", "retry_stopped"].includes(item.event)) ? "stopped"
          : "running";
    const last = historyLogs.at(-1) || {};
    return {
      id,
      startedAt: ordered[0]?.time,
      endedAt: last.time,
      status,
      selectedCountries,
      countryNames: selectedCountries.length ? selectedCountryNames : "全部国家",
      matchedCountryNames: matchedCountryNames || "暂无符合条件的任务",
      taskCount,
      retryCount,
      summary: formatRetryMessage(last.message) || retryRunStatus(status),
      logs: historyLogs.reverse(),
    };
  }).filter((run) => {
    const events = new Set(run.logs.map((item) => item.event));
    if (events.has("manual_run_stopped")) return false;
    return events.has("manual_run_completed") || events.has("scheduled_run_completed") || events.has("manual_run");
  })
    .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
}

function retryRunBadge(status) {
  if (status === "success") return "ok";
  if (status === "failed") return "danger";
  if (status === "stopped") return "idle";
  return "warn";
}

function retryRunStatus(status) {
  return ({ success: "运行成功", failed: "运行失败", stopped: "已停止", running: "运行中" }[status] || "未知");
}

function retryHistoryRunId() {
  if (typeof window === "undefined") return "";
  const query = window.location.hash.split("?")[1] || "";
  return new URLSearchParams(query).get("retryRunId") || "";
}

function renderRetryHistoryDetailPage(root, runId) {
  const run = buildRetryRuns(model.retryLogs).find((item) => item.id === runId);
  if (!run) {
    root.innerHTML = `<section class="panel history-detail-page"><div class="detail-header compact-header"><div><h2 class="panel-title">重跑历史详情</h2><p class="muted">未找到该次重跑记录，可能已超出最近 200 条日志范围。</p></div><a class="link-button" href="#/ds-failure-logs">返回失败任务日志</a></div></section>`;
    return;
  }
  const taskRows = buildRetryTaskRows(run);
  root.innerHTML = `
    <section class="panel history-detail-page">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">重跑历史详情</h2><p class="muted">运行编号：${escapeHtml(run.id)}</p></div>
        <a class="link-button" href="#/ds-failure-logs">返回失败任务日志</a>
      </div>
      <div class="hero-stats">
        ${stat("运行状态", retryRunStatus(run.status))}
        ${stat("选择范围", run.countryNames)}
        ${stat("实际命中", run.matchedCountryNames)}
        ${stat("涉及任务", run.taskCount)}
        ${stat("提交重跑", run.retryCount)}
      </div>
      <div class="schedule-help"><strong>运行时间</strong><span>${formatTime(run.startedAt)} 至 ${formatTime(run.endedAt)}</span><strong>最终结果</strong><span>${escapeHtml(run.summary)}</span></div>
      <div class="table-wrap schedule-history-table ds-retry-history-table">
        <table>
          <thead><tr><th>国家</th><th>失败任务</th><th>失败原因及处理说明</th><th>重跑次数</th><th>重跑结果</th></tr></thead>
          <tbody>${taskRows.map((row) => `<tr><td>${escapeHtml(COUNTRY_META[row.country]?.name || row.country)}</td><td>${row.empty ? "—" : renderRetryTaskIdentity(row.detail, true)}</td><td>${row.empty ? "本轮检查未发现失败任务" : renderRetryLogDetail(row.detail)}</td><td>${row.retryCount}</td><td><span class="badge ${retryRunBadge(row.status)}">${escapeHtml(row.result)}</span></td></tr>`).join("")}</tbody>
        </table>
      </div>
    </section>`;
  scheduleRetryDetailPoll(root, runId, run.status === "running");
}

function buildRetryTaskRows(run) {
  const groups = new Map();
  for (const item of run.logs.filter((entry) => entry.key)) {
    if (!groups.has(item.key)) groups.set(item.key, []);
    groups.get(item.key).push(item);
  }
  const rows = [...groups.values()].map((logs) => {
    const detail = logs[0];
    const outcome = logs.find((item) => ["recovered", "retry_not_recovered", "retry_failed", "excluded", "skipped", "safety_stopped", "manual_review", "retry_already_running"].includes(item.event));
    const status = outcome?.event === "recovered" ? "success"
      : ["retry_not_recovered", "retry_failed"].includes(outcome?.event) ? "failed"
        : ["excluded", "skipped", "safety_stopped", "manual_review"].includes(outcome?.event) ? "stopped" : "running";
    const result = ({ recovered: "重跑后已修复", retry_not_recovered: "重跑后未修复", retry_failed: "重跑提交失败", excluded: "项目配置为不重跑", skipped: "不满足重跑条件", safety_stopped: "安全停止", manual_review: "需人工确认", retry_already_running: "任务已在运行" }[outcome?.event] || "结果待确认");
    return { country: detail.country, detail: outcome || detail, retryCount: logs.filter((item) => item.event === "retry_submitted").length, status, result };
  });
  const selectedCountries = run.selectedCountries?.length ? run.selectedCountries : COUNTRY_OPTIONS.map((item) => item.code);
  const countriesWithTasks = new Set(rows.map((row) => row.country));
  for (const country of selectedCountries) {
    if (!countriesWithTasks.has(country)) rows.push({ country, detail: {}, retryCount: 0, status: "success", result: "无失败任务", empty: true });
  }
  return rows;
}

function scheduleRetryDetailPoll(root, runId, shouldPoll) {
  clearTimeout(retryDetailPollTimer);
  retryDetailPollTimer = null;
  if (!shouldPoll) return;
  retryDetailPollTimer = setTimeout(async () => {
    if (retryHistoryRunId() !== runId || !isCurrentView()) return;
    try {
      const logResult = await apiGet("/api/ds-failure-retry/logs?limit=200");
      model.retryLogs = logResult.logs || [];
      paint(root);
    } catch {
      scheduleRetryDetailPoll(root, runId, true);
    }
  }, 2000);
}

function renderRetryLogDetail(item = {}) {
  if (!item.key) return escapeHtml(formatRetryMessage(item.message) || "—");
  const reason = failureReasonForDisplay(item);
  return `<div class="ds-retry-log-detail"><strong>失败原因</strong><span>${escapeHtml(reason)}</span>${item.message ? `<small>处理记录：${escapeHtml(formatRetryMessage(item.message))}</small>` : ""}</div>`;
}

function deleteRetryRun(root, runId) {
  if (!runId) return;
  model.pendingDeleteRunId = model.pendingDeleteRunId === runId ? "" : runId;
  paint(root);
}

async function confirmDeleteRetryRun(root, runId) {
  if (!runId) return;
  try {
    await apiDelete("/api/ds-failure-retry/logs", { runId });
    model.retryLogs = model.retryLogs.filter((item) => String(item.runId || `legacy-${item.id}`) !== runId);
    model.retryActionMessage = "重跑历史已删除。";
  } catch (error) {
    model.retryActionMessage = `删除重跑历史失败：${error.message}`;
  }
  model.pendingDeleteRunId = "";
  paint(root);
}

function formatRetryMessage(message) {
  return String(message || "").replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g,
    (value) => new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
  );
}

function renderRetryTaskIdentity(item = {}, withLink = false) {
  if (!item.key) return "—";
  const task = item.taskName || item.taskCode || "未返回任务节点名称";
  const workflow = item.workflowName || item.workflowCode || "未知工作流";
  const project = item.projectName || item.projectCode || "未知项目";
  const link = withLink && item.dsInstanceUrl ? `<a href="${escapeHtml(item.dsInstanceUrl)}" target="_blank" rel="noopener">工作流实例 ↗</a>` : "";
  return `<div class="ds-retry-task-identity ds-retry-task-card"><div><strong>${escapeHtml(task)}</strong>${link}</div><small>项目：${escapeHtml(project)} · 工作流：${escapeHtml(workflow)} · 实例：${escapeHtml(item.instanceId || "-")}</small></div>`;
}

function retryLogBadge(level) {
  if (level === "success") return "ok";
  if (level === "error") return "danger";
  if (level === "warn") return "warn";
  return "idle";
}

function retryLogStatus(level) {
  if (level === "success") return "成功";
  if (level === "error") return "失败";
  if (level === "warn") return "已停止";
  return "处理中";
}

function retryLogEvent(event) {
  return ({
    manual_run: "立即运行",
    manual_run_completed: "立即测试完成",
    scheduled_run_started: "定时运行",
    scheduled_run_completed: "定时检查完成",
    manual_run_stopped: "停止立即测试",
    retry_started: "开始处理",
    retry_submitted: "提交重跑",
    retry_failed: "提交失败",
    retry_not_recovered: "重跑后未修复",
    retry_already_running: "任务已在运行",
    retry_stopped: "停止处理",
    recovered: "恢复成功",
    skipped: "跳过任务",
    safety_stopped: "安全停止",
    configuration_error: "配置错误",
    instance_check_failed: "实例检查失败",
    workflow_check_failed: "工作流检查失败",
    empty_run_timeout: "疑似空跑超时",
    owner_notification_sent: "负责人告警已发送",
    owner_notification_failed: "负责人告警发送失败",
    owner_notification_skipped: "未配置负责人",
    owner_notification_test_sent: "负责人通知测试成功",
    owner_notification_test_failed: "负责人通知测试失败",
    manual_review: "转人工确认",
    waiting: "等待运行",
  }[event] || event || "状态更新");
}

function toDateTimeLocal(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function renderCountries(countries) {
  const visible = countries.filter((country) => !model.countries.length || model.countries.includes(country.country));
  if (!visible.length) return `<section class="panel"><p class="muted">所选国家尚未查询，请点击“重新查询”。</p></section>`;
  return visible.map((country) => renderCountry(country, { lookbackDays: model.lookbackDays })).join("");
}

function renderScheduledCountries(countries) {
  const visible = countries.filter((country) => !model.scheduledCountries.length || model.scheduledCountries.includes(country.country));
  if (!visible.length) return `<section class="panel"><p class="muted">所选国家尚未查询，请点击“重新查询”。</p></section>`;
  return visible.map((country) => renderCountry(country, {
    keyword: model.scheduledKeyword,
    status: "",
    scheduleCategory: "scheduled_online",
    historical: true,
    lookbackDays: model.scheduledLookbackDays,
    page: model.scheduledCountryPages[country.country] || 1,
  })).join("");
}

function normalizeUiLookbackDays(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(90, Math.trunc(parsed)));
}

function renderCountry(country, filters = null) {
  const meta = COUNTRY_META[country.country] || {};
  const lookbackDays = normalizeUiLookbackDays(filters?.lookbackDays ?? country.lookbackDays, filters?.historical ? 7 : 1);
  const rangeLabel = lookbackDays === 1 ? "当天" : `最近 ${lookbackDays} 天`;
  if (country.querying) {
    return `<section class="panel ds-failure-country-card ds-failure-querying">
      <div class="detail-header compact-header"><div><h2 class="panel-title">${meta.flag || ""} ${escapeHtml(country.countryName || country.country)}</h2><p class="muted">正在读取${rangeLabel}实例、失败任务和日志…</p></div><span class="badge warn">查询中</span></div>
    </section>`;
  }
  const failures = filteredFailures(country.failures || [], filters);
  const pageSize = filters?.historical ? 4 : Math.max(1, failures.length);
  const pageCount = Math.max(1, Math.ceil(failures.length / pageSize));
  const page = Math.max(1, Math.min(pageCount, Number(filters?.page) || 1));
  const visibleFailures = filters?.historical ? failures.slice((page - 1) * pageSize, page * pageSize) : failures;
  const allFailureCount = (country.failures || []).length;
  const configuredBadge = country.configured
    ? `<span class="badge ${country.success ? "ok" : "danger"}">${country.success ? "已检查" : "检查失败"}</span>`
    : `<span class="badge warn">待配置</span>`;
  const projects = (country.projects || []).map((item) => `${item.projectName || item.projectCode}${item.success ? "" : "（读取失败）"}`).join("、");
  return `<section class="panel ds-failure-country-card">
    <div class="detail-header compact-header">
      <div>
        <h2 class="panel-title">${meta.flag || ""} ${escapeHtml(country.countryName || country.country)} ${configuredBadge}</h2>
        <p class="muted">监控项目：${escapeHtml(projects || "尚未配置")} · ${lookbackDays === 1 ? `当地日期：${escapeHtml(country.targetDate || "-")}` : `截至当地日期：${escapeHtml(country.targetDate || "-")}（${rangeLabel}）`} · 已读取实例：${country.checkedInstances || 0}</p>
      </div>
      <div class="ds-failure-country-count"><strong>${allFailureCount}</strong><span>个失败工作流</span></div>
    </div>
    ${country.error ? `<div class="sandbox-status ${country.configured ? "error" : "warn"}"><strong>${country.queryFailed ? "国家查询失败" : country.configured ? "部分项目读取失败" : "尚未接入"}</strong><span>${escapeHtml(country.error)}${country.configured ? "" : '，请先前往 <a href="#/ds-scheduler">DS调度监控</a> 完成 Token 和项目配置。'}</span></div>` : ""}
    ${country.configured && country.success && failures.length === 0
      ? `<div class="ds-failure-empty">${allFailureCount ? "当前筛选条件下没有失败任务。" : filters?.historical ? `该国家${rangeLabel}没有 n8n 失败重启任务。` : `该国家${rangeLabel}没有失败任务。`}</div>`
      : visibleFailures.map((failure) => renderFailure(failure, filters)).join("")}
    ${filters?.historical && failures.length > pageSize ? renderScheduledCountryPagination(country.country, failures.length, page, pageCount) : ""}
  </section>`;
}

function renderScheduledCountryPagination(country, total, page, pageCount) {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
  return `<div class="ds-retry-history-pagination ds-scheduled-country-pagination">
    <span>总条目为: ${total}</span>
    <button class="ds-pagination-arrow" type="button" data-scheduled-country="${escapeHtml(country)}" data-scheduled-country-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="上一页">‹</button>
    ${pages.map((item) => `<button class="ds-pagination-page ${item === page ? "active" : ""}" type="button" data-scheduled-country="${escapeHtml(country)}" data-scheduled-country-page="${item}">${item}</button>`).join("")}
    <button class="ds-pagination-arrow" type="button" data-scheduled-country="${escapeHtml(country)}" data-scheduled-country-page="${page + 1}" ${page >= pageCount ? "disabled" : ""} aria-label="下一页">›</button>
    <select class="ds-pagination-size" aria-label="每页条数" disabled><option value="4">4 / 页</option></select>
  </div>`;
}

function filteredFailures(failures, filters = null) {
  const keyword = String(filters?.keyword ?? model.keyword).trim().toLowerCase();
  const statusFilter = filters?.status ?? model.status;
  const scheduleFilter = filters?.scheduleCategory ?? model.scheduleCategory;
  return failures.filter((item) => {
    const displayStatus = item.repairStatus === "recovered" ? "recovered" : item.failureType || item.repairStatus;
    if (statusFilter && displayStatus !== statusFilter) return false;
    if (scheduleFilter && item.scheduleCategory !== scheduleFilter) return false;
    if (!keyword) return true;
    return [item.projectName, item.workflowName, item.workflowCode, item.taskName, item.failureMessage]
      .some((value) => String(value || "").toLowerCase().includes(keyword));
  });
}

function renderFailure(item, filters = null) {
  const displayStatus = item.repairStatus === "recovered" ? "recovered" : item.failureType || item.repairStatus || "unresolved";
  const status = STATUS_LABELS[displayStatus] || STATUS_LABELS.unresolved;
  const taskUnlocated = !item.taskName && !item.taskCode;
  const failureReason = failureReasonForDisplay(item);
  const unlocatedNotice = taskUnlocated
    ? `<div class="sandbox-status warn"><strong>失败节点尚未定位</strong><span>该工作流状态为失败或停止。请进入 DS 工作流实例，在失败或停止节点中查看日志确定具体原因。${item.dsInstanceUrl ? ` <a href="${escapeHtml(item.dsInstanceUrl)}" target="_blank" rel="noopener noreferrer">查看节点日志 ↗</a>` : ""}</span></div>`
    : "";
  const taskLabel = item.taskName || item.taskCode || "未定位到失败任务";
  const scriptLabel = item.taskType === "SQL" ? "出错 SQL" : "任务执行脚本";
  const retryCount = Number(item.retryCount || 0);
  const retryResult = item.retryResult === "recovered"
    ? "已恢复"
    : item.retryResult === "running"
      ? "重跑中"
      : item.retryResult === "timeout_needs_owner"
        ? "观察超过 30 分钟，需负责人处理"
      : item.retryResult === "failed"
        ? "重跑后仍失败"
        : "尚未触发后续重跑";
  return `<article class="ds-failure-item ${escapeHtml(displayStatus)}">
    <div class="ds-failure-item-head">
      <div><span class="badge ${status.className}">${status.label}</span><strong>${escapeHtml(item.workflowName || item.workflowCode || "未命名工作流")}</strong></div>
      <div class="ds-failure-item-actions">
        <time>${formatTime(item.startTime)}</time>
        ${item.dsInstanceUrl ? `<a class="ds-instance-link" href="${escapeHtml(item.dsInstanceUrl)}" target="_blank" rel="noopener noreferrer">工作流实例 ↗</a>` : ""}
      </div>
    </div>
    <div class="ds-failure-levels">
      <div><span>失败项目</span><strong>${escapeHtml(item.projectName || item.projectCode || "未命名项目")}</strong><small>${escapeHtml(item.projectCode || "-")}</small></div>
      <div><span>失败工作流</span><strong>${escapeHtml(item.workflowName || item.workflowCode || "未命名工作流")}</strong><small>${escapeHtml(item.workflowCode || "-")}</small></div>
      <div><span>失败任务</span><strong>${escapeHtml(taskLabel)}</strong><small>${escapeHtml([item.taskType, item.taskCode].filter(Boolean).join(" · ") || "任务信息未返回")}</small></div>
    </div>
    ${unlocatedNotice}
    <div class="ds-failure-meta">
      <span>失败实例：${escapeHtml(item.instanceId || "-")}</span>
      <span>失败状态：${escapeHtml(item.instanceState || "FAILURE")}</span>
      <span>${filters?.historical ? "本次原始失败" : "当天失败次数"}：${filters?.historical ? 1 : item.failureCount || 1}</span>
    </div>
    <div class="ds-failure-reason"><strong>失败原因</strong><pre>${escapeHtml(failureReason)}</pre></div>
    <div class="ds-failure-recovery"><strong>失败分类</strong><span>${escapeHtml(item.retryDecision || "等待失败原因分类；本模块仅查询，不执行重跑")}</span></div>
    ${filters?.historical && item.n8nDecision ? `<div class="ds-failure-recovery"><strong>n8n 处理规则</strong><span>${escapeHtml(item.n8nDecision)}</span></div>` : ""}
    ${item.taskScript ? `<details class="ds-failure-sql"><summary>${scriptLabel} · ${escapeHtml(taskLabel)}</summary><pre>${escapeHtml(item.taskScript)}</pre></details>` : `<div class="ds-failure-sql-missing"><strong>${scriptLabel}</strong><span>${item.taskConfigError ? `任务配置读取失败：${escapeHtml(item.taskConfigError)}` : "DS 未返回该任务的 SQL 或执行脚本"}</span></div>`}
    ${filters?.historical ? `<div class="ds-failure-recovery"><strong>后续重跑结果</strong><span>${escapeHtml(retryResult)} · 重跑 ${retryCount} 次${item.recoveryInstanceId ? ` · 最新重跑实例 ${escapeHtml(item.recoveryInstanceId)} · ${escapeHtml(item.recoveryState || "-")} · ${formatTime(item.recoveryTime)}` : ""}</span></div>` : item.repairStatus !== "unresolved" ? `<div class="ds-failure-recovery"><strong>${displayStatus === "recovered" ? "查询结果" : "后续状态"}</strong><span>后续实例 ${escapeHtml(item.recoveryInstanceId || "-")} · ${escapeHtml(item.recoveryState || "-")} · ${formatTime(item.recoveryTime)}</span></div>` : ""}
    ${item.logError ? `<p class="field-error">任务日志读取补充信息：${escapeHtml(item.logError)}</p>` : ""}
  </article>`;
}

function failureReasonForDisplay(item = {}) {
  const stopped = ["STOP", "STOPPED", "KILL", "5", "9"].includes(String(item.instanceState || "").toUpperCase());
  if (!item.taskName && !item.taskCode && !stopped) return "失败节点尚未定位，可能为空跑，具体原因需人工确认";
  return describeFailureReason(item.failureReason || item.failureMessage || "任务日志未返回明确失败原因");
}

function describeFailureReason(reason) {
  const text = String(reason || "").trim();
  if (!text || /[\u3400-\u9fff]/.test(text)) return text;
  const descriptions = [
    [/permission denied|access denied|unauthorized|forbidden|insufficient privilege/i, "权限不足或访问被拒绝"],
    [/syntax error|sqlsyntaxerrorexception|parse exception/i, "SQL 或代码语法错误"],
    [/unknown column|column .+(?:not found|does not exist)/i, "引用的字段不存在"],
    [/table .+(?:not found|does not exist)|no such table/i, "引用的表不存在"],
    [/out of memory|memory limit|\boom\b/i, "内存不足或超过资源限制"],
    [/connection reset|connection refused|network error|socket hang up|broken pipe/i, "网络连接异常"],
    [/timed out|timeout/i, "执行或连接超时"],
    [/no available worker|worker .+(?:lost|offline|unavailable)/i, "没有可用执行节点"],
    [/exit(?:ed)? (?:code )?137|sigkill|killed/i, "进程被系统终止，通常与资源不足有关"],
    [/service unavailable|temporarily unavailable|too many requests/i, "服务暂时不可用或请求过多"],
  ];
  const matched = descriptions.find(([pattern]) => pattern.test(text));
  return `${text}（${matched?.[1] || "英文报错，具体原因需人工确认"}）`;
}

function stat(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function formatScheduleTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "-") : date.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

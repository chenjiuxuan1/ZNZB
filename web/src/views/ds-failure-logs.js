import { apiGet, apiPost } from "../api.js";
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
  manual_review: { label: "待人工确认", className: "danger" },
  safety_stopped: { label: "已停止重跑", className: "danger" },
  sql_error: { label: "SQL错误，需人工修改", className: "danger" },
  recoverable: { label: "自动重跑中", className: "warn" },
};

let model = {
  result: null,
  loading: false,
  error: "",
  status: "",
  keyword: "",
  completed: 0,
  total: 0,
  runId: 0,
  country: "",
  nextAutoRefreshAt: 0,
  retryControl: { enabled: false, startAt: null, activeCount: 0, logCount: 0 },
  retryCountry: "",
  retryLogs: [],
  retryControlLoaded: false,
  retryActionLoading: false,
  retryActionMessage: "",
};

let autoRefreshTimer = null;

export function renderDsFailureLogs(root) {
  syncAutoRefresh(root);
  paint(root);
  if (!model.retryControlLoaded) refreshRetryPanel(root);
}

async function refreshRetryPanel(root) {
  try {
    const [control, logResult] = await Promise.all([
      apiGet("/api/ds-failure-retry/control"),
      apiGet("/api/ds-failure-retry/logs?limit=200"),
    ]);
    model.retryControl = control;
    model.retryCountry = control.countries?.length === 1 ? control.countries[0] : model.retryCountry;
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
  model.retryActionLoading = true;
  model.retryActionMessage = "";
  paint(root);
  try {
    if (model.retryControl.enabled) {
      model.retryControl = await apiPost("/api/ds-failure-retry/stop");
      model.retryActionMessage = "已停止自动重跑；正在运行的任务将在下一次状态检查时退出。";
    } else {
      const input = root.querySelector("#ds-retry-start-at")?.value;
      if (!input) throw new Error("请选择重跑开始时间");
      const startAt = new Date(input);
      if (Number.isNaN(startAt.getTime())) throw new Error("重跑开始时间无效");
      model.retryControl = await apiPost("/api/ds-failure-retry/start", {
        startAt: startAt.toISOString(),
        countries: model.retryCountry ? [model.retryCountry] : [],
      });
      model.retryActionMessage = startAt.getTime() > Date.now() ? "重跑计划已保存，到达所选时间后自动开始。" : "已启动符合条件失败任务的重跑。";
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

async function load(root) {
  if (model.loading) return;
  clearAutoRefresh();
  const selected = COUNTRY_OPTIONS.filter((item) => !model.country || item.code === model.country);

  const runId = ++model.runId;
  model.loading = true;
  model.error = "";
  model.completed = 0;
  model.total = selected.length;
  model.result = aggregateResult(selected.map(queryingCountry));
  paint(root);

  await Promise.all(selected.map(async (option) => {
    let country;
    try {
      const response = await apiGet(`/api/ds-failure-logs?country=${encodeURIComponent(option.code)}`, { timeoutMs: 55_000 });
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
  if (isCurrentView()) {
    syncAutoRefresh(root);
    paint(root);
  }
}

function unresolvedFailureCount() {
  return (model.result?.countries || [])
    .filter((country) => !model.country || country.country === model.country)
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
  if (/timeout|timed out|abort/i.test(message)) return "查询超过 55 秒，DS 网关或目标国家响应过慢";
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
  const result = model.result
    ? aggregateResult(model.result.countries.filter((item) => !model.country || item.country === model.country))
    : {};
  const hasResult = Boolean(model.result);
  const selectedCount = model.country ? 1 : COUNTRY_OPTIONS.length;
  const autoRefreshNotice = model.nextAutoRefreshAt
    ? `<div class="sandbox-status warn"><strong>待修复任务自动复查</strong><span>页面将每隔 1 小时自动重新查询当前国家；下次复查时间：${formatTime(model.nextAutoRefreshAt)}</span></div>`
    : "";
  const retryStartValue = toDateTimeLocal(model.retryControl.startAt || new Date());
  const retryStateLabel = model.retryControl.enabled
    ? Date.parse(model.retryControl.startAt || "") > Date.now() ? "等待计划时间" : "自动重跑已启用"
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
    ${model.error ? `<div class="sandbox-status error"><strong>无法查询</strong><span>${escapeHtml(model.error)}</span></div>` : ""}
    <section class="panel ds-failure-toolbar">
      ${autoRefreshNotice}
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">当天失败任务</h2><p class="muted">选择需要观察的国家后点击查询。每个国家独立返回，查询中的国家不会阻塞已完成国家的结果。</p></div>
        <button class="primary" id="ds-failure-query" ${model.loading ? "disabled" : ""}>${model.loading ? `正在查询 ${model.completed}/${model.total}` : hasResult ? "重新查询" : "查询"}</button>
      </div>
      <div class="ds-failure-filter-grid">
        <label>国家<select id="ds-failure-country" ${model.loading ? "disabled" : ""}><option value="">全部国家</option>${COUNTRY_OPTIONS.map((item) => `<option value="${item.code}" ${model.country === item.code ? "selected" : ""}>${item.flag} ${item.name}</option>`).join("")}</select></label>
        <label>修复状态<select id="ds-failure-status"><option value="">全部状态</option>${Object.entries(STATUS_LABELS).map(([value, item]) => `<option value="${value}" ${model.status === value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
        <label>搜索项目或任务<input id="ds-failure-keyword" value="${escapeHtml(model.keyword)}" placeholder="项目、工作流、失败任务或原因"></label>
      </div>
      <div class="ds-failure-legend"><span class="badge ok">已自动修复</span><span>最新失败实例后出现成功实例</span><span class="badge warn">修复中</span><span>最新失败实例后出现运行中实例</span><span class="badge danger">待修复</span><span>最新失败实例后没有成功或运行中实例</span></div>
    </section>
    <section class="panel ds-failure-retry-control">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">失败任务重跑控制</h2><p class="muted">仅处理资源、网络或运行环境类可恢复故障；SQL/代码错误、人工停止、下线及跨天任务不会重跑。</p></div>
        <div class="ds-retry-header-actions">
          <span class="badge ${model.retryControl.enabled ? "warn" : "danger"}">${retryStateLabel}</span>
          <button class="secondary ds-retry-action" id="ds-retry-refresh-logs" ${model.retryActionLoading ? "disabled" : ""}>刷新日志</button>
          <button class="${model.retryControl.enabled ? "danger" : "primary"} ds-retry-action" id="ds-retry-toggle" ${model.retryActionLoading ? "disabled" : ""}>${model.retryActionLoading ? "处理中…" : model.retryControl.enabled ? "停止重跑" : "启动重跑"}</button>
        </div>
      </div>
      <div class="ds-failure-filter-grid">
        <label>重跑开始时间<input id="ds-retry-start-at" type="datetime-local" value="${escapeHtml(retryStartValue)}" ${model.retryControl.enabled ? "disabled" : ""}></label>
        <label>重跑国家<select id="ds-retry-country" ${model.retryControl.enabled ? "disabled" : ""}><option value="">全部国家</option>${COUNTRY_OPTIONS.map((item) => `<option value="${item.code}" ${model.retryCountry === item.code ? "selected" : ""}>${item.flag} ${item.name}</option>`).join("")}</select></label>
        <label>当前运行任务<input value="${Number(model.retryControl.activeCount || 0)} 个" disabled></label>
      </div>
      ${model.retryActionMessage ? `<div class="sandbox-status ${/失败|错误|无效|请选择/.test(model.retryActionMessage) ? "error" : "warn"}"><span>${escapeHtml(model.retryActionMessage)}</span></div>` : ""}
      <div class="sub-panel ds-retry-history">
        <div class="detail-header compact-header">
          <div><h3 class="panel-title">重跑日志</h3><p class="muted">按时间倒序展示最近 ${model.retryLogs.length} 条重跑记录。</p></div>
        </div>
        ${renderRetryLogs(model.retryLogs)}
      </div>
    </section>
    <section class="ds-failure-country-list">
      ${hasResult ? renderCountries(result.countries || []) : `<section class="panel ds-failure-empty"><strong>尚未查询</strong><p class="muted">选择需要观察的国家，然后点击“查询”。</p></section>`}
    </section>
  `;

  root.querySelector("#ds-failure-query")?.addEventListener("click", () => load(root));
  root.querySelector("#ds-failure-country")?.addEventListener("change", (event) => { model.country = event.target.value; paint(root); });
  root.querySelector("#ds-failure-status")?.addEventListener("change", (event) => { model.status = event.target.value; paint(root); });
  root.querySelector("#ds-failure-keyword")?.addEventListener("input", (event) => { model.keyword = event.target.value; paint(root); root.querySelector("#ds-failure-keyword")?.focus(); });
  root.querySelector("#ds-retry-toggle")?.addEventListener("click", () => toggleRetry(root));
  root.querySelector("#ds-retry-refresh-logs")?.addEventListener("click", () => refreshRetryPanel(root));
  root.querySelector("#ds-retry-country")?.addEventListener("change", (event) => { model.retryCountry = event.target.value; paint(root); });
}

function renderRetryLogs(logs) {
  if (!logs.length) return `<p class="muted">暂无重跑日志。启动重跑后，每次扫描、跳过、提交、失败、恢复和安全停止都会在这里留下一条记录。</p>`;
  return `
    <div class="table-wrap schedule-history-table ds-retry-history-table">
      <table>
        <thead><tr><th>运行时间</th><th>状态</th><th>国家</th><th>事件</th><th>次数</th><th>任务</th><th>明细</th></tr></thead>
        <tbody>${logs.map((item) => `
          <tr>
            <td>${escapeHtml(formatTime(item.time))}</td>
            <td><span class="badge ${retryLogBadge(item.level)}">${escapeHtml(retryLogStatus(item.level))}</span></td>
            <td>${escapeHtml(COUNTRY_META[item.country]?.name || item.country || "全部")}</td>
            <td>${escapeHtml(retryLogEvent(item.event))}</td>
            <td>${Number(item.attempts || 0) || "—"}</td>
            <td><code>${escapeHtml(item.key || "—")}</code></td>
            <td>${escapeHtml(item.message || "—")}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>`;
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
    control_enabled: "启用重跑",
    control_disabled: "停止重跑",
    retry_started: "开始处理",
    retry_submitted: "提交重跑",
    retry_failed: "提交失败",
    retry_stopped: "停止处理",
    recovered: "恢复成功",
    skipped: "跳过任务",
    safety_stopped: "安全停止",
    configuration_error: "配置错误",
    instance_check_failed: "实例检查失败",
    workflow_check_failed: "工作流检查失败",
    manual_review: "转人工确认",
  }[event] || event || "状态更新");
}

function toDateTimeLocal(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function renderCountries(countries) {
  const visible = countries.filter((country) => !model.country || model.country === country.country);
  if (!visible.length) return `<section class="panel"><p class="muted">所选国家尚未查询，请点击“重新查询”。</p></section>`;
  return visible.map((country) => renderCountry(country)).join("");
}

function renderCountry(country) {
  const meta = COUNTRY_META[country.country] || {};
  if (country.querying) {
    return `<section class="panel ds-failure-country-card ds-failure-querying">
      <div class="detail-header compact-header"><div><h2 class="panel-title">${meta.flag || ""} ${escapeHtml(country.countryName || country.country)}</h2><p class="muted">正在读取当天实例、失败任务和日志…</p></div><span class="badge warn">查询中</span></div>
    </section>`;
  }
  const failures = filteredFailures(country.failures || []);
  const allFailureCount = (country.failures || []).length;
  const configuredBadge = country.configured
    ? `<span class="badge ${country.success ? "ok" : "danger"}">${country.success ? "已检查" : "检查失败"}</span>`
    : `<span class="badge warn">待配置</span>`;
  const projects = (country.projects || []).map((item) => `${item.projectName || item.projectCode}${item.success ? "" : "（读取失败）"}`).join("、");
  return `<section class="panel ds-failure-country-card">
    <div class="detail-header compact-header">
      <div>
        <h2 class="panel-title">${meta.flag || ""} ${escapeHtml(country.countryName || country.country)} ${configuredBadge}</h2>
        <p class="muted">监控项目：${escapeHtml(projects || "尚未配置")} · 当地日期：${escapeHtml(country.targetDate || "-")} · 已读取实例：${country.checkedInstances || 0}</p>
      </div>
      <div class="ds-failure-country-count"><strong>${allFailureCount}</strong><span>个失败工作流</span></div>
    </div>
    ${country.error ? `<div class="sandbox-status ${country.configured ? "error" : "warn"}"><strong>${country.queryFailed ? "国家查询失败" : country.configured ? "部分项目读取失败" : "尚未接入"}</strong><span>${escapeHtml(country.error)}${country.configured ? "" : '，请先前往 <a href="#/ds-scheduler">DS调度监控</a> 完成 Token 和项目配置。'}</span></div>` : ""}
    ${country.configured && country.success && failures.length === 0
      ? `<div class="ds-failure-empty">${allFailureCount ? "当前筛选条件下没有失败任务。" : "该国家当天没有失败任务。"}</div>`
      : failures.map(renderFailure).join("")}
  </section>`;
}

function filteredFailures(failures) {
  const keyword = model.keyword.trim().toLowerCase();
  return failures.filter((item) => {
    const displayStatus = item.autoRetryStatus || item.failureType || item.repairStatus;
    if (model.status && displayStatus !== model.status) return false;
    if (!keyword) return true;
    return [item.projectName, item.workflowName, item.workflowCode, item.taskName, item.failureMessage]
      .some((value) => String(value || "").toLowerCase().includes(keyword));
  });
}

function renderFailure(item) {
  const displayStatus = item.autoRetryStatus || item.failureType || item.repairStatus || "unresolved";
  const status = STATUS_LABELS[displayStatus] || STATUS_LABELS.unresolved;
  const taskUnlocated = !item.taskName && !item.taskCode;
  const unlocatedNotice = taskUnlocated
    ? `<div class="sandbox-status warn"><strong>失败节点尚未定位</strong><span>该工作流状态为失败或停止。请进入 DS 工作流实例，在失败或停止节点中查看日志确定具体原因。${item.dsInstanceUrl ? ` <a href="${escapeHtml(item.dsInstanceUrl)}" target="_blank" rel="noopener noreferrer">查看节点日志 ↗</a>` : ""}</span></div>`
    : "";
  const taskLabel = item.taskName || item.taskCode || "未定位到失败任务";
  const scriptLabel = item.taskType === "SQL" ? "出错 SQL" : "任务执行脚本";
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
      <span>当天失败次数：${item.failureCount || 1}</span>
    </div>
    <div class="ds-failure-reason"><strong>失败原因</strong><pre>${escapeHtml(item.failureMessage || "任务日志未返回明确失败原因")}</pre></div>
    <div class="ds-failure-recovery"><strong>重跑策略</strong><span>${escapeHtml(item.retryDecision || "等待失败原因分类")}${Number(item.attempts || 0) ? ` · 已重跑 ${Number(item.attempts)} 次` : ""}${item.lastError ? ` · 最近错误：${escapeHtml(item.lastError)}` : ""}</span></div>
    ${item.taskScript ? `<details class="ds-failure-sql"><summary>${scriptLabel} · ${escapeHtml(taskLabel)}</summary><pre>${escapeHtml(item.taskScript)}</pre></details>` : `<div class="ds-failure-sql-missing"><strong>${scriptLabel}</strong><span>${item.taskConfigError ? `任务配置读取失败：${escapeHtml(item.taskConfigError)}` : "DS 未返回该任务的 SQL 或执行脚本"}</span></div>`}
    ${item.repairStatus !== "unresolved" || item.stopReason ? `<div class="ds-failure-recovery"><strong>${displayStatus === "recovered" ? "修复结果" : "修复进度"}</strong><span>${item.stopReason ? escapeHtml(item.stopReason) : `后续实例 ${escapeHtml(item.recoveryInstanceId || "-")} · ${escapeHtml(item.recoveryState || "-")} · ${formatTime(item.recoveryTime)}`}</span></div>` : ""}
    ${item.logError ? `<p class="field-error">任务日志读取补充信息：${escapeHtml(item.logError)}</p>` : ""}
  </article>`;
}

function stat(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString("zh-CN", { hour12: false });
}

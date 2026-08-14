import { apiGet } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_FLAGS = { cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽" };
const STATUS_LABELS = {
  recovered: { label: "已自动修复", className: "ok" },
  repairing: { label: "修复中", className: "warn" },
  unresolved: { label: "待修复", className: "danger" },
};

let model = { result: null, loading: false, error: "", country: "", status: "", keyword: "" };

export function renderDsFailureLogs(root) {
  paint(root);
}

async function load(root) {
  if (model.loading) return;
  model.loading = true;
  model.error = "";
  paint(root);
  try {
    model.result = await apiGet("/api/ds-failure-logs");
  } catch (error) {
    model.error = error.message;
  } finally {
    model.loading = false;
  }
  paint(root);
}

function paint(root) {
  const result = model.result || {};
  const hasResult = Boolean(model.result);
  root.innerHTML = `
    <div class="page-header batch-hero ds-failure-hero">
      <div>
        <h1 class="page-title">DS 失败任务日志</h1>
        <p class="page-note">点击查询后读取六个国家当天的失败实例，判断失败后是否出现成功实例，并展示底层失败任务日志原因。</p>
      </div>
      <div class="hero-stats">
        ${stat("已接入国家", hasResult ? `${result.configuredCountries || 0} / 6` : "—")}
        ${stat("失败任务", hasResult ? result.totalFailures || 0 : "—")}
        ${stat("已自动修复", hasResult ? result.recoveredCount || 0 : "—")}
        ${stat("修复中 / 待修复", hasResult ? `${result.repairingCount || 0} / ${result.unresolvedCount || 0}` : "—")}
      </div>
    </div>
    ${model.error ? `<div class="sandbox-status error"><strong>读取失败</strong><span>${escapeHtml(model.error)}</span></div>` : ""}
    <section class="panel ds-failure-toolbar">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">当天失败任务</h2><p class="muted">不会自动查询。点击右侧按钮后，只读取六个国家各自当地当天的数据。</p></div>
        <button class="primary" id="ds-failure-query" ${model.loading ? "disabled" : ""}>${model.loading ? "正在查询…" : hasResult ? "重新查询当天" : "查询当天失败任务"}</button>
      </div>
      <div class="ds-failure-filter-grid">
        <label>国家<select id="ds-failure-country"><option value="">全部国家</option>${(result.countries || []).map((item) => `<option value="${escapeHtml(item.country)}" ${model.country === item.country ? "selected" : ""}>${escapeHtml(item.countryName)}</option>`).join("")}</select></label>
        <label>修复状态<select id="ds-failure-status"><option value="">全部状态</option>${Object.entries(STATUS_LABELS).map(([value, item]) => `<option value="${value}" ${model.status === value ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>
        <label>搜索项目或任务<input id="ds-failure-keyword" value="${escapeHtml(model.keyword)}" placeholder="项目、工作流、失败任务或原因"></label>
      </div>
      <div class="ds-failure-legend"><span class="badge ok">已自动修复</span><span>失败后已有成功实例</span><span class="badge warn">修复中</span><span>失败后已有新实例正在运行</span><span class="badge danger">待修复</span><span>尚未发现后续成功实例</span></div>
    </section>
    <section class="ds-failure-country-list">
      ${hasResult ? renderCountries(result.countries || []) : `<section class="panel ds-failure-empty"><strong>尚未查询</strong><p class="muted">点击“查询当天失败任务”后显示六个国家当天的失败任务、自动修复状态和失败原因。</p></section>`}
    </section>
  `;

  root.querySelector("#ds-failure-query")?.addEventListener("click", () => load(root));
  root.querySelector("#ds-failure-country")?.addEventListener("change", (event) => { model.country = event.target.value; paint(root); });
  root.querySelector("#ds-failure-status")?.addEventListener("change", (event) => { model.status = event.target.value; paint(root); });
  root.querySelector("#ds-failure-keyword")?.addEventListener("input", (event) => { model.keyword = event.target.value; paint(root); root.querySelector("#ds-failure-keyword")?.focus(); });
}

function renderCountries(countries) {
  const visible = countries.filter((country) => !model.country || country.country === model.country);
  if (!visible.length) return `<section class="panel"><p class="muted">没有符合筛选条件的国家。</p></section>`;
  return visible.map((country) => renderCountry(country)).join("");
}

function renderCountry(country) {
  const failures = filteredFailures(country.failures || []);
  const allFailureCount = (country.failures || []).length;
  const configuredBadge = country.configured
    ? `<span class="badge ${country.success ? "ok" : "danger"}">${country.success ? "已检查" : "检查失败"}</span>`
    : `<span class="badge warn">待配置</span>`;
  const projects = (country.projects || []).map((item) => `${item.projectName || item.projectCode}${item.success ? "" : "（读取失败）"}`).join("、");
  return `<section class="panel ds-failure-country-card">
    <div class="detail-header compact-header">
      <div>
        <h2 class="panel-title">${COUNTRY_FLAGS[country.country] || ""} ${escapeHtml(country.countryName || country.country)} ${configuredBadge}</h2>
        <p class="muted">监控项目：${escapeHtml(projects || "尚未配置")} · 当地日期：${escapeHtml(country.targetDate || "-")} · 已读取实例：${country.checkedInstances || 0}</p>
      </div>
      <div class="ds-failure-country-count"><strong>${allFailureCount}</strong><span>个失败工作流</span></div>
    </div>
    ${country.error ? `<div class="sandbox-status ${country.configured ? "error" : "warn"}"><strong>${country.configured ? "部分项目读取失败" : "尚未接入"}</strong><span>${escapeHtml(country.error)}${country.configured ? "" : '，请先前往 <a href="#/ds-scheduler">DS调度监控</a> 完成 Token 和项目配置。'}</span></div>` : ""}
    ${country.configured && failures.length === 0
      ? `<div class="ds-failure-empty">${allFailureCount ? "当前筛选条件下没有失败任务。" : "当前日期没有失败任务。"}</div>`
      : failures.map(renderFailure).join("")}
  </section>`;
}

function filteredFailures(failures) {
  const keyword = model.keyword.trim().toLowerCase();
  return failures.filter((item) => {
    if (model.status && item.repairStatus !== model.status) return false;
    if (!keyword) return true;
    return [item.projectName, item.workflowName, item.workflowCode, item.taskName, item.failureMessage]
      .some((value) => String(value || "").toLowerCase().includes(keyword));
  });
}

function renderFailure(item) {
  const status = STATUS_LABELS[item.repairStatus] || STATUS_LABELS.unresolved;
  return `<article class="ds-failure-item ${escapeHtml(item.repairStatus || "unresolved")}">
    <div class="ds-failure-item-head">
      <div><span class="badge ${status.className}">${status.label}</span><strong>${escapeHtml(item.projectName || item.projectCode || "未命名项目")} / ${escapeHtml(item.workflowName || item.workflowCode || "未命名工作流")}</strong></div>
      <time>${formatTime(item.startTime)}</time>
    </div>
    <div class="ds-failure-meta">
      <span>失败实例：${escapeHtml(item.instanceId || "-")}</span>
      <span>失败状态：${escapeHtml(item.instanceState || "FAILURE")}</span>
      <span>失败次数：${item.failureCount || 1}</span>
      ${item.taskName ? `<span>失败任务：${escapeHtml(item.taskName)}</span>` : ""}
    </div>
    <div class="ds-failure-reason"><strong>失败原因</strong><pre>${escapeHtml(item.failureMessage || "任务日志未返回明确失败原因")}</pre></div>
    ${item.repairStatus !== "unresolved" ? `<div class="ds-failure-recovery"><strong>${item.repairStatus === "recovered" ? "修复结果" : "修复进度"}</strong><span>后续实例 ${escapeHtml(item.recoveryInstanceId || "-")} · ${escapeHtml(item.recoveryState || "-")} · ${formatTime(item.recoveryTime)}</span></div>` : ""}
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

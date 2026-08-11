import { apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const COUNTRY_FLAGS = { cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽" };
let model = { config: {}, history: {}, result: null, status: null, busy: false };

export function summarizeHiveCountryCheck(country = {}) {
  const notRun = Number(country.notRunCount || 0);
  const abnormal = Number(country.abnormalCount || 0);
  const failed = country.success === false;
  const hasIssue = failed || notRun > 0 || abnormal > 0;
  return {
    hasIssue,
    badgeClass: failed ? "danger" : (hasIssue ? "warn" : "ok"),
    badgeText: failed ? "检查失败" : (hasIssue ? "有异常" : "正常"),
    summary: `应检查 ${country.checkedWorkflows || 0} 个工作流 · 未运行 ${notRun} · 状态异常 ${abnormal}`,
  };
}

export function renderHiveScheduler(root) {
  root.innerHTML = `<section class="panel"><p class="muted">正在加载 HIVE 调度监控配置…</p></section>`;
  void load(root);
}

async function load(root) {
  try {
    [model.config, model.history] = await Promise.all([
      apiGet("/api/hive-scheduler/config"),
      apiGet("/api/hive-scheduler/history?limit=20"),
    ]);
  } catch (error) {
    model.status = { type: "error", text: `HIVE 配置加载失败：${error.message}` };
  }
  paint(root);
}

function paint(root) {
  const result = model.result || model.history?.runs?.[0]?.result || null;
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">HIVE 调度监控</h1>
        <p class="page-note">独立配置各国项目；每轮定时巡检只校验一次，发现异常时只提醒对应国家负责人。</p>
      </div>
      <div class="hero-stats">
        ${stat("监控国家", enabledCountryCount())}
        ${stat("应检查工作流", result?.totalChecked ?? "—")}
        ${stat("未运行 / 状态异常", result ? `${result.totalNotRun || 0} / ${result.totalAbnormal || 0}` : "—")}
        ${stat("检查失败", result?.failedCountries ?? "—")}
      </div>
    </div>
    ${renderStatus()}
    <section class="panel ds-config-section">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">项目配置</h2><p class="muted">勾选要监控的国家，并填写该国家需要监控的项目；一个国家下的全部项目只提醒该国负责人。</p></div>
        <div class="button-group"><button id="hive-save">保存项目配置</button><button class="primary" id="hive-test">执行 HIVE 测试</button></div>
      </div>
      <div class="notice compact-notice"><strong>模块隔离</strong><span>此处配置、巡检、通知和历史记录均独立运行，不会改变“定时巡检”或“DS 调度监控”。测试按钮只读取状态，不发送通知。</span></div>
      <div class="schedule-country-grid ds-project-grid">${COUNTRY_ORDER.map(renderCountryCard).join("")}</div>
      <details class="advanced compact ds-token-details">
        <summary>高级：HIVE 巡检网关、各国 Token 与通知机器人</summary>
        <div class="ds-project-fields ds-gateway-field"><label>n8n webhook<input id="hive-webhook" value="${escapeHtml(model.config.n8nWebhookUrl || "http://127.0.0.1:5678/webhook/ds-scheduler")}"></label></div>
        <div class="schedule-country-grid ds-token-grid">${COUNTRY_ORDER.map((code) => `<label>${COUNTRY_LABELS[code]} Token<input class="hive-token" data-country="${code}" type="password" value="${escapeHtml(model.config.countries?.[code]?.token || "")}" placeholder="首次配置时填写"></label>`).join("")}</div>
        <div class="ds-project-fields ds-gateway-field">
          <label>TV webhook<input id="hive-alert-webhook" value="${escapeHtml(model.config.alertRouting?.webhookUrl || "")}"></label>
          <label>机器人 botId<input id="hive-bot-id" value="${escapeHtml(model.config.alertRouting?.botId || "")}"></label>
        </div>
      </details>
    </section>
    ${renderResult(result)}
    ${renderHistory()}
  `;
  root.querySelector("#hive-save")?.addEventListener("click", () => saveConfig(root));
  root.querySelector("#hive-test")?.addEventListener("click", () => runTest(root));
  root.querySelectorAll(".hive-enabled").forEach((input) => input.addEventListener("change", () => updateCountrySwitch(input)));
}

function renderCountryCard(code) {
  const country = model.config.countries?.[code] || {};
  const status = model.config.projectStatus?.[code] || {};
  const owner = (model.config.alertRouting?.countryMentions?.[code] || []).join("，");
  return `<article class="schedule-country-card ds-project-card ${country.enabled ? "is-enabled" : ""}" data-country="${code}">
    <div class="schedule-country-card-header"><div><strong>${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</strong> <span class="badge hive-country-state ${country.enabled ? "ok" : "danger"}">${country.enabled ? "监控中" : "未监控"}</span></div><label class="mini-switch"><input class="hive-enabled" type="checkbox" ${country.enabled ? "checked" : ""}><span></span><em>${country.enabled ? "已开启" : "开启监控"}</em></label></div>
    <div class="ds-project-fields ds-project-name-only">
      <label>项目名称（可多个）<input class="hive-projects" value="${escapeHtml(model.config.projectNames?.[code] || "")}" placeholder="用逗号、分号或换行分隔"></label>
      <label>国家负责人邮箱<input class="hive-owner" value="${escapeHtml(owner)}" placeholder="异常时精准 @，可填写多个"></label>
    </div>
    ${(status.projects || []).length ? `<div class="project-match-list">${status.projects.map((item) => `<span class="badge ${item.code ? "ok" : "warn"}">${escapeHtml(item.name)} · ${item.code ? "已匹配" : "待匹配"}</span>`).join("")}</div>` : ""}
    ${status.error ? `<p class="field-error">${escapeHtml(status.error)}</p>` : ""}
  </article>`;
}

function collectConfig(root) {
  const countries = {};
  const projectNames = {};
  const countryMentions = {};
  for (const code of COUNTRY_ORDER) {
    const card = root.querySelector(`.ds-project-card[data-country="${code}"]`);
    countries[code] = {
      name: COUNTRY_LABELS[code],
      enabled: Boolean(card?.querySelector(".hive-enabled")?.checked),
      token: root.querySelector(`.hive-token[data-country="${code}"]`)?.value.trim() || model.config.countries?.[code]?.token || "",
    };
    projectNames[code] = card?.querySelector(".hive-projects")?.value.trim() || "";
    countryMentions[code] = card?.querySelector(".hive-owner")?.value.trim() || "";
  }
  return {
    n8nWebhookUrl: root.querySelector("#hive-webhook")?.value.trim() || "",
    countries,
    projectNames,
    alertRouting: {
      webhookUrl: root.querySelector("#hive-alert-webhook")?.value.trim() || "",
      botId: root.querySelector("#hive-bot-id")?.value.trim() || "",
      countryMentions,
    },
  };
}

async function saveConfig(root) {
  await perform(root, async () => {
    const saved = await apiPut("/api/hive-scheduler/config", collectConfig(root));
    model.config = await apiGet("/api/hive-scheduler/config");
    model.status = saved.resolveErrors?.length
      ? { type: "warn", text: `配置已保存，但部分项目未匹配：${saved.resolveErrors.map((item) => `${item.country} ${item.name}`).join("；")}` }
      : { type: "success", text: "HIVE 项目配置已保存。" };
  });
}

async function runTest(root) {
  await perform(root, async () => {
    model.result = await apiPost("/api/hive-scheduler/check", {});
    model.status = { type: "success", text: "HIVE 测试完成，本次未发送通知。" };
  });
}

function updateCountrySwitch(input) {
  const card = input.closest(".ds-project-card");
  const enabled = Boolean(input.checked);
  card?.classList.toggle("is-enabled", enabled);
  const badge = card?.querySelector(".hive-country-state");
  badge?.classList.toggle("ok", enabled);
  badge?.classList.toggle("danger", !enabled);
  if (badge) badge.textContent = enabled ? "监控中" : "未监控";
  const label = input.closest(".mini-switch")?.querySelector("em");
  if (label) label.textContent = enabled ? "已开启" : "开启监控";
}

async function perform(root, action) {
  if (model.busy) return;
  model.busy = true;
  root.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try { await action(); } catch (error) { model.status = { type: "error", text: error.message }; }
  model.busy = false;
  paint(root);
  root.querySelector(".sandbox-status")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderResult(result) {
  if (!result) return `<section class="panel ds-config-section"><h2 class="panel-title">巡检结果</h2><p class="muted">尚未执行 HIVE 巡检。</p></section>`;
  return `<section class="panel ds-config-section"><div class="detail-header compact-header"><div><h2 class="panel-title">巡检结果</h2><p class="muted">${formatTime(result.checkedAt)}</p></div></div><div class="card-list">${(result.countries || []).map((country) => {
    const view = summarizeHiveCountryCheck(country);
    const details = [...(country.notRunWorkflows || []).map((item) => `未运行｜${item.projectName}｜${item.workflowName || item.workflowCode}`), ...(country.abnormalWorkflows || []).map((item) => `异常｜${item.projectName}｜${item.workflowName || item.workflowCode}`)];
    return `<article class="card-row ds-result-card"><div><h3>${escapeHtml(country.countryName || country.country)}</h3><p>${view.summary}</p>${country.error ? `<p class="field-error">${escapeHtml(country.error)}</p>` : ""}${details.length ? `<details><summary>查看 ${details.length} 个异常工作流</summary>${details.map((item) => `<div class="ds-detail-item">• ${escapeHtml(item)}</div>`).join("")}</details>` : ""}</div><span class="badge ${view.badgeClass}">${view.badgeText}</span></article>`;
  }).join("")}</div></section>`;
}

function renderHistory() {
  const runs = model.history?.runs || [];
  if (!runs.length) return "";
  return `<section class="panel ds-config-section"><details><summary>HIVE 巡检记录（最近 ${runs.length} 次）</summary><div class="card-list">${runs.map((run) => `<article class="card-row"><div><h3>${formatTime(run.startedAt)} · ${run.trigger === "schedule" ? "定时" : "手动"}</h3><p>${run.ok ? `检查 ${run.result?.totalChecked || 0}，未运行 ${run.result?.totalNotRun || 0}，异常 ${run.result?.totalAbnormal || 0}` : escapeHtml(run.error || "巡检失败")}</p></div><span class="badge ${run.ok ? "ok" : "danger"}">${run.ok ? "完成" : "失败"}</span></article>`).join("")}</div></details></section>`;
}

function enabledCountryCount() { return Object.values(model.config.countries || {}).filter((item) => item.enabled).length; }
function renderStatus() { return model.status ? `<div class="sandbox-status ${model.status.type}"><strong>提示</strong><span>${escapeHtml(model.status.text)}</span></div>` : ""; }
function stat(label, value) { return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`; }
function formatTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString("zh-CN", { hour12: false }); }

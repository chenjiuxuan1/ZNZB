import { apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const COUNTRY_FLAGS = { cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽" };
let model = { config: {}, schedule: {}, history: { runs: [] }, status: null };

export function renderDsScheduler(root) {
  root.innerHTML = `<section class="panel"><p class="muted">正在加载 DS 调度监控配置…</p></section>`;
  load(root);
}

async function load(root) {
  const [config, schedule, history] = await Promise.allSettled([
    apiGet("/api/ds-scheduler/config"),
    apiGet("/api/ds-scheduler/schedule"),
    apiGet("/api/ds-scheduler/history?limit=20"),
  ]);
  model = {
    config: config.status === "fulfilled" ? config.value : {},
    schedule: schedule.status === "fulfilled" ? schedule.value : {},
    history: history.status === "fulfilled" ? history.value : { runs: [] },
    status: [config, schedule, history].some((item) => item.status === "rejected")
      ? { type: "error", text: "部分 DS 配置加载失败，已保留可用内容。" }
      : null,
  };
  paint(root);
}

function paint(root) {
  const result = model.schedule.lastResult || model.history.runs?.[0]?.result || null;
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">按国家配置 DolphinScheduler 项目范围，定时识别连续失败、长时间运行和异常离线任务。</p>
      </div>
      <div class="hero-stats">
        ${stat("监控项目", enabledCountries().length)}
        ${stat("检查工作流", result?.totalChecked ?? "—")}
        ${stat("卡死 / 离线", result ? `${result.totalStuck || 0} / ${result.totalStale || 0}` : "—")}
        ${stat("检查失败", result?.failedCountries ?? "—")}
      </div>
    </div>
    ${renderStatus()}
    ${renderProjectSection()}
    ${renderScheduleSection()}
    ${renderResultSection(result)}
  `;
  bind(root);
}

function stat(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function renderStatus() {
  if (!model.status) return "";
  return `<div class="sandbox-status ${model.status.type}"><strong>${model.status.type === "success" ? "操作成功" : "提示"}</strong><span>${escapeHtml(model.status.text)}</span></div>`;
}

function renderProjectSection() {
  const config = model.config || {};
  return `
    <section class="panel ds-config-section">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">项目配置</h2>
          <p class="muted">每个国家配置一个需要巡检的 DS 项目。项目码可直接填写；只填名称时系统会尝试自动匹配。</p>
        </div>
        <button class="primary" id="ds-save-projects">保存项目配置</button>
      </div>
      <div class="schedule-country-grid ds-project-grid">
        ${COUNTRY_ORDER.map((code) => {
          const country = config.countries?.[code] || {};
          const projectCode = config.projectCodes?.[code] || "";
          return `
            <article class="schedule-country-card ds-project-card" data-country="${code}">
              <div class="schedule-country-card-header">
                <div><strong>${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</strong>
                  <span class="badge ${projectCode && country.token ? "ok" : "warn"}">${projectCode && country.token ? "已接入" : "待配置"}</span>
                </div>
              </div>
              <div class="ds-project-fields">
                <label>项目名称<input class="ds-project-name" value="${escapeHtml(config.projectNames?.[code] || "")}" placeholder="如：数据平台"></label>
                <label>项目码<input class="ds-project-code" value="${escapeHtml(projectCode)}" placeholder="建议直接填写 project code"></label>
              </div>
            </article>`;
        }).join("")}
      </div>
      <details class="advanced compact ds-token-details">
        <summary>高级：DS Token 与 n8n 网关</summary>
        <div class="ds-project-fields ds-gateway-field">
          <label>n8n webhook<input id="ds-webhook-url" value="${escapeHtml(config.n8nWebhookUrl || "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler")}"></label>
        </div>
        <div class="schedule-country-grid ds-token-grid">
          ${COUNTRY_ORDER.map((code) => `<label>${COUNTRY_LABELS[code]} Token<input class="ds-country-token" data-country="${code}" type="password" value="${escapeHtml(config.countries?.[code]?.token || "")}" placeholder="首次配置时填写"></label>`).join("")}
        </div>
      </details>
    </section>`;
}

function renderScheduleSection() {
  const schedule = model.schedule || {};
  const configs = new Map((schedule.countryConfigs || []).map((item) => [item.countryCode, item]));
  const alerts = schedule.alerts || model.config.alerts || {};
  const target = alerts.recipientEmails || alerts.chatId || alerts.botId || "未配置接收目标";
  return `
    <section class="panel ds-config-section">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">定时巡检</h2>
          <p class="muted">只巡检下方启用的国家项目，通知人和消息渠道直接继承 Metabase 定时巡检。</p>
        </div>
        <div class="button-group">
          <button id="ds-save-schedule">保存配置</button>
          <button class="primary" id="ds-run-now">立即运行测试</button>
        </div>
      </div>
      <div class="schedule-config-card">
        <label class="switch-field">
          <input id="ds-schedule-enabled" type="checkbox" ${schedule.enabled ? "checked" : ""}>
          <span class="switch-track"></span><strong>启用定时巡检</strong>
          <small>服务端每分钟判断是否到期</small>
        </label>
        <label>巡检间隔（分钟）<input id="ds-interval" type="number" min="5" value="${escapeHtml(schedule.intervalMinutes || 60)}"></label>
        <div><small>下次运行</small><strong>${formatTime(schedule.nextRunAt)}</strong></div>
        <div><small>上次运行</small><strong>${formatTime(schedule.lastRunAt)}</strong></div>
      </div>
      <div class="notice compact-notice">
        <strong>通知继承</strong>
        <span>${escapeHtml(channelLabel(alerts.channel))} · ${escapeHtml(target)}。如需修改，请前往 <a href="#/batch-check">Metabase 定时巡检</a>。</span>
      </div>
      <div class="schedule-country-grid ds-scope-grid">
        ${COUNTRY_ORDER.map((code) => {
          const projectCode = model.config.projectCodes?.[code] || "";
          const item = configs.get(code) || {};
          return `
            <article class="schedule-country-card ds-scope-card" data-country="${code}">
              <div class="schedule-country-card-header">
                <div><strong>${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</strong><span class="badge ${projectCode ? "ok" : "warn"}">${projectCode ? "项目已配置" : "缺少项目码"}</span></div>
                <label class="mini-switch">
                  <input class="ds-country-enabled" type="checkbox" ${item.enabled ? "checked" : ""} ${projectCode ? "" : "disabled"}>
                  <span></span><em>巡检</em>
                </label>
              </div>
              <p class="muted">项目码：${escapeHtml(projectCode || "请先在上方配置")}</p>
            </article>`;
        }).join("")}
      </div>
    </section>`;
}

function renderResultSection(result) {
  const latest = model.history.runs?.[0];
  if (!result && !latest) {
    return `<section class="panel"><h2 class="panel-title">最近一次结果</h2><p class="muted">尚未运行 DS 巡检。</p></section>`;
  }
  if (!result) {
    return `<section class="panel"><h2 class="panel-title">最近一次结果</h2><div class="sandbox-status error"><strong>运行失败</strong><span>${escapeHtml(latest.error || "未知错误")}</span></div></section>`;
  }
  return `
    <section class="panel">
      <div class="detail-header compact-header"><div><h2 class="panel-title">最近一次结果</h2><p class="muted">${formatTime(result.checkedAt)}</p></div></div>
      <div class="card-list">
        ${(result.countries || []).map((country) => `
          <article class="card-row">
            <div><h3>${escapeHtml(country.countryName || COUNTRY_LABELS[country.country] || country.country)}</h3>
              <p>检查 ${country.checkedWorkflows || 0} 个工作流 · 卡死 ${country.stuckCount || 0} · 离线 ${country.staleCount || 0}</p>
              ${country.error ? `<p class="danger-text">${escapeHtml(country.error)}</p>` : ""}
            </div>
            <span class="badge ${country.success ? ((country.stuckCount || country.staleCount) ? "warn" : "ok") : "danger"}">${country.success ? ((country.stuckCount || country.staleCount) ? "有异常" : "正常") : "失败"}</span>
          </article>`).join("")}
      </div>
    </section>`;
}

function bind(root) {
  root.querySelector("#ds-save-projects")?.addEventListener("click", () => saveProjects(root));
  root.querySelector("#ds-save-schedule")?.addEventListener("click", () => saveSchedule(root));
  root.querySelector("#ds-run-now")?.addEventListener("click", () => runNow(root));
}

async function saveProjects(root) {
  setBusy(root, "#ds-save-projects", true, "保存中…");
  try {
    const countries = {};
    const projectNames = {};
    const projectCodes = {};
    for (const code of COUNTRY_ORDER) {
      const card = root.querySelector(`.ds-project-card[data-country="${code}"]`);
      projectNames[code] = card?.querySelector(".ds-project-name")?.value.trim() || "";
      projectCodes[code] = card?.querySelector(".ds-project-code")?.value.trim() || "";
      countries[code] = {
        name: COUNTRY_LABELS[code],
        token: root.querySelector(`.ds-country-token[data-country="${code}"]`)?.value.trim() || model.config.countries?.[code]?.token || "",
      };
    }
    model.config = await apiPut("/api/ds-scheduler/config", {
      n8nWebhookUrl: root.querySelector("#ds-webhook-url")?.value.trim() || "",
      countries, projectNames, projectCodes,
    });
    model.status = model.config.resolveErrors?.length
      ? { type: "error", text: `配置已保存，但部分项目名称匹配失败：${model.config.resolveErrors.map((item) => `${item.country} ${item.error}`).join("；")}` }
      : { type: "success", text: "DS 项目配置已保存。" };
    model.schedule = await apiGet("/api/ds-scheduler/schedule");
  } catch (error) {
    model.status = { type: "error", text: `项目配置保存失败：${error.message}` };
  }
  paint(root);
}

async function saveSchedule(root) {
  setBusy(root, "#ds-save-schedule", true, "保存中…");
  try {
    model.schedule = await apiPut("/api/ds-scheduler/schedule", collectSchedule(root));
    model.status = { type: "success", text: "DS 定时巡检配置已保存。" };
  } catch (error) {
    model.status = { type: "error", text: `定时配置保存失败：${error.message}` };
  }
  paint(root);
}

async function runNow(root) {
  setBusy(root, "#ds-run-now", true, "巡检中…");
  try {
    await apiPut("/api/ds-scheduler/schedule", collectSchedule(root));
    const response = await apiPost("/api/ds-scheduler/schedule/run-now", {});
    model.schedule = response.schedule;
    model.history = await apiGet("/api/ds-scheduler/history?limit=20");
    model.status = { type: "success", text: `巡检完成：检查 ${response.result.totalChecked || 0} 个工作流，发现 ${Number(response.result.totalStuck || 0) + Number(response.result.totalStale || 0)} 个异常。` };
  } catch (error) {
    model.status = { type: "error", text: `DS 巡检失败：${error.message}` };
  }
  paint(root);
}

function collectSchedule(root) {
  return {
    enabled: root.querySelector("#ds-schedule-enabled")?.checked || false,
    intervalMinutes: Number(root.querySelector("#ds-interval")?.value || 60),
    countryConfigs: COUNTRY_ORDER.map((code) => ({
      countryCode: code,
      enabled: root.querySelector(`.ds-scope-card[data-country="${code}"] .ds-country-enabled`)?.checked || false,
      projectCode: model.config.projectCodes?.[code] || "",
    })),
  };
}

function enabledCountries() {
  return (model.schedule.countryConfigs || []).filter((item) => item.enabled);
}

function setBusy(root, selector, disabled, text) {
  const button = root.querySelector(selector);
  if (!button) return;
  button.disabled = disabled;
  button.textContent = text;
}

function channelLabel(channel) {
  return channel === "knBot" ? "KN Chat" : channel === "tv" ? "TV webhook" : channel || "通知渠道";
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString("zh-CN", { hour12: false });
}

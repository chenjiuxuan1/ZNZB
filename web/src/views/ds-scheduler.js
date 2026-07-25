import { apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const COUNTRY_FLAGS = { cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽" };
let model = { config: {}, schedule: {}, notification: {}, history: { runs: [] }, preview: null, status: null };

export function renderDsScheduler(root) {
  root.innerHTML = `<section class="panel"><p class="muted">正在加载 DS 调度监控配置…</p></section>`;
  load(root);
}

async function load(root) {
  const [config, schedule, notification, history] = await Promise.allSettled([
    apiGet("/api/ds-scheduler/config"),
    apiGet("/api/ds-scheduler/schedule"),
    apiGet("/api/ds-scheduler/notification"),
    apiGet("/api/ds-scheduler/history?limit=20"),
  ]);
  model = {
    config: config.status === "fulfilled" ? config.value : {},
    schedule: schedule.status === "fulfilled" ? schedule.value : {},
    notification: notification.status === "fulfilled" ? notification.value : {},
    history: history.status === "fulfilled" ? history.value : { runs: [] },
    preview: null,
    status: [config, schedule, notification, history].some((item) => item.status === "rejected")
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
    ${renderNotificationSection()}
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
          <p class="muted">每个国家只需填写需要巡检的 DS 项目名称，系统会在后台自动匹配项目。</p>
        </div>
        <button class="primary" id="ds-save-projects">保存项目配置</button>
      </div>
      <div class="schedule-country-grid ds-project-grid">
        ${COUNTRY_ORDER.map((code) => {
          const country = config.countries?.[code] || {};
          const projectStatus = config.projectStatus?.[code] || {};
          const resolved = projectStatus.status === "resolved";
          return `
            <article class="schedule-country-card ds-project-card" data-country="${code}">
              <div class="schedule-country-card-header">
                <div><strong>${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</strong>
                  <span class="badge ${resolved && country.token ? "ok" : "warn"}">${resolved && country.token ? "已接入" : "待匹配"}</span>
                </div>
              </div>
              <div class="ds-project-fields ds-project-name-only">
                <label>项目名称<input class="ds-project-name" value="${escapeHtml(config.projectNames?.[code] || "")}" placeholder="如：数据平台"></label>
              </div>
              ${projectStatus.error ? `<p class="field-error">${escapeHtml(projectStatus.error)}</p>` : ""}
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
  const alerts = model.notification || {};
  return `
    <section class="panel ds-config-section">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">定时巡检</h2>
          <p class="muted">只巡检下方启用且项目名称已成功匹配的国家。</p>
        </div>
        <div class="button-group">
          <button id="ds-save-schedule">保存配置</button>
          <button class="primary" id="ds-run-now">立即巡检并按配置通知</button>
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
        <strong>本次通知</strong>
        <span>${escapeHtml(alerts.targetSummary || `${channelLabel(alerts.channel)} · 未配置接收目标`)}。可在下方“通知配置与测试”中修改。</span>
      </div>
      <div class="schedule-country-grid ds-scope-grid">
        ${COUNTRY_ORDER.map((code) => {
          const resolved = model.config.projectStatus?.[code]?.status === "resolved";
          const item = configs.get(code) || {};
          return `
            <article class="schedule-country-card ds-scope-card" data-country="${code}">
              <div class="schedule-country-card-header">
                <div><strong>${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</strong><span class="badge ${resolved ? "ok" : "warn"}">${resolved ? "项目已匹配" : "项目名称未匹配"}</span></div>
                <label class="mini-switch">
                  <input class="ds-country-enabled" type="checkbox" ${item.enabled ? "checked" : ""} ${resolved ? "" : "disabled"}>
                  <span></span><em>巡检</em>
                </label>
              </div>
              <p class="muted">${resolved ? `项目：${escapeHtml(model.config.projectNames?.[code] || "已匹配")}` : "请先保存并成功匹配项目名称"}</p>
            </article>`;
        }).join("")}
      </div>
    </section>`;
}

function renderNotificationSection() {
  const item = model.notification || {};
  const channel = item.channel || "knBot";
  return `
    <section class="panel ds-config-section">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">通知配置与测试</h2>
          <p class="muted">DS 首次使用 Metabase 通知配置；在这里保存后转为 DS 独立配置，不会影响 Metabase。</p>
        </div>
        <div class="button-group">
          <button id="ds-preview-notification">预览消息</button>
          <button id="ds-send-notification-test">发送测试</button>
          <button class="primary" id="ds-save-notification">保存通知配置</button>
        </div>
      </div>
      <div class="notice compact-notice">
        <strong>${item.inherited ? "当前继承 Metabase" : "当前使用 DS 独立配置"}</strong>
        <span>${escapeHtml(item.targetSummary || "尚未配置通知目标")}</span>
      </div>
      <div class="schedule-config-card ds-notification-form">
        <label>通知渠道
          <select id="ds-notify-channel">
            <option value="knBot" ${channel === "knBot" ? "selected" : ""}>KN Chat Bot</option>
            <option value="tv" ${channel === "tv" ? "selected" : ""}>TV webhook</option>
          </select>
        </label>
        <label class="ds-kn-field">接收人邮箱<input id="ds-recipient-emails" value="${escapeHtml(item.recipientEmails || "")}" placeholder="多个邮箱用逗号分隔"></label>
        <label class="ds-kn-field">群聊 Chat ID<input id="ds-chat-id" value="${escapeHtml(item.chatId || "")}" placeholder="可选，多个用逗号分隔"></label>
        <label class="ds-kn-field">KN Bot Token<input id="ds-bot-token" type="password" value="${escapeHtml(item.botToken || "")}" placeholder="KN Chat Bot Token"></label>
        <label class="ds-tv-field">TV webhook<input id="ds-notify-webhook" value="${escapeHtml(item.webhookUrl || "")}" placeholder="TV webhook URL"></label>
        <label class="ds-tv-field">TV bot_id<input id="ds-notify-bot-id" value="${escapeHtml(item.botId || "")}" placeholder="TV 机器人 ID"></label>
        <label class="ds-tv-field">TV 提醒人<input id="ds-notify-mentions" value="${escapeHtml(Array.isArray(item.mentions) ? item.mentions.join(",") : item.mentions || "")}" placeholder="多个用逗号分隔"></label>
        <label class="switch-field">
          <input id="ds-send-healthy" type="checkbox" ${item.sendWhenHealthy !== false ? "checked" : ""}>
          <span class="switch-track"></span><strong>健康时也发送</strong>
          <small>关闭后仅在发现卡死、离线或检查失败时通知</small>
        </label>
      </div>
      ${model.preview ? `
        <div class="ds-notification-preview">
          <div class="detail-header compact-header"><strong>消息预览</strong><span class="badge ok">${escapeHtml(model.preview.targetSummary || "")}</span></div>
          <pre class="code">${escapeHtml(model.preview.message || "")}</pre>
        </div>` : ""}
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
  root.querySelector("#ds-save-notification")?.addEventListener("click", () => saveNotification(root));
  root.querySelector("#ds-preview-notification")?.addEventListener("click", () => previewNotification(root));
  root.querySelector("#ds-send-notification-test")?.addEventListener("click", () => sendNotificationTest(root));
  root.querySelector("#ds-notify-channel")?.addEventListener("change", () => updateNotificationVisibility(root));
  updateNotificationVisibility(root);
}

async function saveProjects(root) {
  setBusy(root, "#ds-save-projects", true, "保存中…");
  try {
    const countries = {};
    const projectNames = {};
    for (const code of COUNTRY_ORDER) {
      const card = root.querySelector(`.ds-project-card[data-country="${code}"]`);
      projectNames[code] = card?.querySelector(".ds-project-name")?.value.trim() || "";
      countries[code] = {
        name: COUNTRY_LABELS[code],
        token: root.querySelector(`.ds-country-token[data-country="${code}"]`)?.value.trim() || model.config.countries?.[code]?.token || "",
      };
    }
    const saved = await apiPut("/api/ds-scheduler/config", {
      n8nWebhookUrl: root.querySelector("#ds-webhook-url")?.value.trim() || "",
      countries, projectNames,
    });
    model.config = await apiGet("/api/ds-scheduler/config");
    model.status = saved.resolveErrors?.length
      ? { type: "error", text: `配置已保存，但部分项目名称匹配失败：${saved.resolveErrors.map((item) => `${item.country} ${item.error}`).join("；")}` }
      : { type: "success", text: "DS 项目配置已保存。" };
    model.schedule = await apiGet("/api/ds-scheduler/schedule");
  } catch (error) {
    model.status = { type: "error", text: `项目配置保存失败：${error.message}` };
  }
  paint(root);
}

async function saveNotification(root) {
  try {
    model.notification = await apiPut("/api/ds-scheduler/notification", collectNotification(root));
    model.status = { type: "success", text: `DS 通知配置已保存：${model.notification.targetSummary}` };
  } catch (error) {
    model.status = { type: "error", text: `通知配置保存失败：${error.message}` };
  }
  paint(root);
}

async function previewNotification(root) {
  try {
    model.preview = await apiPost("/api/ds-scheduler/notification/preview", collectNotification(root));
    model.status = { type: "success", text: "通知消息预览已生成，尚未发送。" };
  } catch (error) {
    model.status = { type: "error", text: `消息预览失败：${error.message}` };
  }
  paint(root);
}

async function sendNotificationTest(root) {
  try {
    model.notification = await apiPut("/api/ds-scheduler/notification", collectNotification(root));
    const preview = model.preview || await apiPost("/api/ds-scheduler/notification/preview", model.notification);
    const result = await apiPost("/api/ds-scheduler/notification/test", { message: preview.message });
    model.preview = preview;
    model.status = { type: result.sent ? "success" : "error", text: result.sent ? `测试消息已发送：${result.targetSummary}` : `测试消息发送失败：${result.reason || "请检查配置"}` };
  } catch (error) {
    model.status = { type: "error", text: `测试消息发送失败：${error.message}` };
  }
  paint(root);
}

function collectNotification(root) {
  return {
    channel: root.querySelector("#ds-notify-channel")?.value || "knBot",
    recipientEmails: root.querySelector("#ds-recipient-emails")?.value.trim() || "",
    chatId: root.querySelector("#ds-chat-id")?.value.trim() || "",
    botToken: root.querySelector("#ds-bot-token")?.value.trim() || model.notification.botToken || "",
    webhookUrl: root.querySelector("#ds-notify-webhook")?.value.trim() || "",
    botId: root.querySelector("#ds-notify-bot-id")?.value.trim() || "",
    mentions: root.querySelector("#ds-notify-mentions")?.value.trim() || "",
    sendWhenHealthy: root.querySelector("#ds-send-healthy")?.checked || false,
  };
}

function updateNotificationVisibility(root) {
  const channel = root.querySelector("#ds-notify-channel")?.value || "knBot";
  root.querySelectorAll(".ds-kn-field").forEach((field) => { field.hidden = channel !== "knBot"; });
  root.querySelectorAll(".ds-tv-field").forEach((field) => { field.hidden = channel !== "tv"; });
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

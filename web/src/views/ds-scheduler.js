import { apiGet, apiPut, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_LABELS = {
  cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥",
};
const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];

const COUNTRY_FLAGS = {
  cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽",
};

export function renderDsScheduler(root) {
  const activeTab = state.dsTab || "overview";

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">监控 DolphinScheduler 定时任务连续性，识别卡死和离线任务</p>
      </div>
      <div class="page-header-actions">
        <button id="ds-run-check" class="btn btn-primary" style="white-space:nowrap;">
          <span class="btn-icon">🔍</span> 执行全面检查
        </button>
      </div>
    </div>

    <div class="batch-tabs">
      <button class="batch-tab ${activeTab === "overview" ? "active" : ""}" data-ds-tab="overview">📊 总览</button>
      <button class="batch-tab ${activeTab === "notify" ? "active" : ""}" data-ds-tab="notify">🔔 通知配置</button>
      <button class="batch-tab ${activeTab === "schedule" ? "active" : ""}" data-ds-tab="schedule">⏰ 定时任务</button>
      <button class="batch-tab ${activeTab === "history" ? "active" : ""}" data-ds-tab="history">📜 运行历史</button>
    </div>

    <div id="ds-tab-content"></div>
  `;

  root.querySelectorAll("[data-ds-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dsTab = button.dataset.dsTab;
      renderDsScheduler(root);
    });
  });

  const tabContent = root.querySelector("#ds-tab-content");
  if (activeTab === "overview") {
    renderDsOverviewTab(tabContent);
  } else if (activeTab === "notify") {
    renderDsNotifyTab(tabContent);
  } else if (activeTab === "schedule") {
    renderDsScheduleTab(tabContent);
  } else if (activeTab === "history") {
    renderDsHistoryTab(tabContent);
  }
}

let dsScheduleCache = null;
let dsHistoryCache = null;
let dsConfigCache = null;

async function loadDsSchedule() {
  if (!dsScheduleCache) {
    dsScheduleCache = await apiGet("/api/ds-scheduler/schedule").catch(() => null);
  }
  return dsScheduleCache;
}

async function loadDsHistory() {
  if (!dsHistoryCache) {
    dsHistoryCache = await apiGet("/api/ds-scheduler/history?limit=50").catch(() => ({ runs: [] }));
  }
  return dsHistoryCache;
}

function renderDsOverviewTab(container) {
  container.innerHTML = `
    <!-- 概览指标卡片 -->
    <div class="ds-metrics-grid" id="ds-overview">
      <div class="ds-metric-card ds-metric-info">
        <div class="ds-metric-icon">🌐</div>
        <div class="ds-metric-body">
          <div class="ds-metric-label">监控国家</div>
          <div class="ds-metric-value" id="ds-metric-countries">—</div>
        </div>
      </div>
      <div class="ds-metric-card ds-metric-info">
        <div class="ds-metric-icon">📋</div>
        <div class="ds-metric-body">
          <div class="ds-metric-label">在检查工作流</div>
          <div class="ds-metric-value" id="ds-metric-workflows">—</div>
        </div>
      </div>
      <div class="ds-metric-card ds-metric-danger">
        <div class="ds-metric-icon">⛔</div>
        <div class="ds-metric-body">
          <div class="ds-metric-label">卡死工作流</div>
          <div class="ds-metric-value" id="ds-metric-stuck">—</div>
        </div>
      </div>
      <div class="ds-metric-card ds-metric-warning">
        <div class="ds-metric-icon">⚠️</div>
        <div class="ds-metric-body">
          <div class="ds-metric-label">离线/旷工任务</div>
          <div class="ds-metric-value" id="ds-metric-stale">—</div>
        </div>
      </div>
      <div class="ds-metric-card ds-metric-error">
        <div class="ds-metric-icon">❌</div>
        <div class="ds-metric-body">
          <div class="ds-metric-label">检查失败国家</div>
          <div class="ds-metric-value" id="ds-metric-failed">—</div>
        </div>
      </div>
    </div>

    <!-- 监控说明 -->
    <div class="ds-info-panel">
      <div class="ds-info-header">
        <span class="ds-info-icon">📖</span>
        <strong>监控说明</strong>
      </div>
      <div class="ds-info-body">
        <p>DS 调度监控会定期检查 <strong>6 个国家</strong>（中国、印尼、菲律宾、泰国、巴基斯坦、墨西哥）的 DolphinScheduler 定时任务。</p>
        <div class="ds-info-features">
          <div class="ds-info-feature">
            <span class="ds-feature-icon">⛔</span>
            <div>
              <strong>卡死检测</strong>
              <p><em>1. 连续失败</em>：检查是否连续 N 次运行失败（默认 3 次）；<em>2. 长时间运行</em>：检查是否任务执行超过合理时间未结束。</p>
            </div>
          </div>
          <div class="ds-info-feature">
            <span class="ds-feature-icon">⚠️</span>
            <div>
              <strong>旷工/离线检测</strong>
              <p>识别异常下线的工作流：<em>一周内曾保持上线</em> 且 <em>存在下游依赖</em> 但当前突然下线，将告警给负责人。</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 监控范围配置 -->
    <div class="ds-section">
      <div class="ds-section-header">
        <div class="ds-section-title">
          <span class="ds-section-icon">⚙️</span>
          <span>监控范围配置</span>
        </div>
        <div class="ds-section-actions">
          <button id="ds-save-config" class="btn btn-primary" style="display: inline-flex;">
            <span class="btn-icon">💾</span> 保存配置
          </button>
          <span id="ds-save-status" class="ds-save-status"></span>
        </div>
      </div>
      <div class="ds-config-layout">
        <div class="ds-project-config-area">
          <h3 class="ds-area-title">📁 国家项目映射</h3>
          <div class="ds-project-grid" id="ds-project-grid"></div>
        </div>
        <div class="ds-token-config-area">
          <div class="ds-token-toggle" id="ds-token-toggle">
            <span>🔑 DS Token 配置</span>
            <span class="ds-toggle-arrow">▶</span>
          </div>
          <div class="ds-token-grid" id="ds-token-grid" style="display: none;"></div>
        </div>
      </div>
    </div>

    <div id="ds-check-result"></div>
  `;

  loadDsConfigAndRender(container);
  setupDsOverviewEvents(container);
}

async function loadDsConfigAndRender(container) {
  try {
    const config = await apiGet("/api/ds-scheduler/config");
    dsConfigCache = config;
    renderProjectGrid(container.querySelector("#ds-project-grid"), config);
    renderTokenGrid(container.querySelector("#ds-token-grid"), config);
  } catch (error) {
    console.error("Failed to load DS config:", error);
  }
}

function setupDsOverviewEvents(container) {
  container.querySelector("#ds-run-check")?.addEventListener("click", async () => {
    const resultContainer = container.querySelector("#ds-check-result");
    resultContainer.innerHTML = `<div class="ds-loading">⏳ 正在执行全面检查...</div>`;
    try {
      const result = await apiPost("/api/ds-scheduler/check-and-notify", {});
      renderCheckResult(resultContainer, result);
    } catch (error) {
      resultContainer.innerHTML = `<div class="ds-error">❌ 检查失败：${escapeHtml(error.message)}</div>`;
    }
  });

  container.querySelector("#ds-token-toggle")?.addEventListener("click", () => {
    const grid = container.querySelector("#ds-token-grid");
    const arrow = container.querySelector(".ds-toggle-arrow");
    if (grid.style.display === "none") {
      grid.style.display = "grid";
      arrow.textContent = "▼";
    } else {
      grid.style.display = "none";
      arrow.textContent = "▶";
    }
  });

  container.querySelector("#ds-save-config")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-save-status");
    statusEl.textContent = "保存中...";
    try {
      const config = collectDsConfigFromDom(container);
      const result = await apiPut("/api/ds-scheduler/config", config);
      statusEl.textContent = "✓ 已保存";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
      dsConfigCache = result;
    } catch (error) {
      statusEl.textContent = "✗ 保存失败：" + error.message;
    }
  });
}

function collectDsConfigFromDom(container) {
  const config = dsConfigCache || { countries: {}, projectNames: {} };
  const countries = { ...config.countries };
  const projectNames = { ...config.projectNames };

  container.querySelectorAll(".ds-token-input").forEach((input) => {
    const code = input.dataset.country;
    if (code && countries[code]) {
      countries[code] = { ...countries[code], token: input.value };
    }
  });

  container.querySelectorAll(".ds-project-input").forEach((input) => {
    const code = input.dataset.country;
    if (code) {
      projectNames[code] = input.value;
    }
  });

  return { ...config, countries, projectNames };
}

function renderDsNotifyTab(container) {
  container.innerHTML = `
    <div class="batch-config-card">
      <div class="batch-config-header">
        <h3>🔔 通知渠道配置</h3>
        <p>配置 DS 调度监控的告警通知方式，支持 TV 告警机器人 和 KN Chat Bot</p>
      </div>
      <div id="ds-notify-content">
        <div class="ds-loading">加载中...</div>
      </div>
    </div>
  `;
  loadDsSchedule().then((schedule) => {
    renderDsNotifyForm(container.querySelector("#ds-notify-content"), schedule || {});
  });
}

function renderDsNotifyForm(container, schedule) {
  const channel = schedule.notifyChannel || "tv";
  const isKn = channel === "knBot";

  container.innerHTML = `
    <div class="form-row">
      <label class="form-label">通知渠道</label>
      <select id="ds-notify-channel" class="form-input">
        <option value="tv" ${channel === "tv" ? "selected" : ""}>TV 告警机器人</option>
        <option value="knBot" ${isKn ? "selected" : ""}>KN Chat Bot</option>
      </select>
    </div>

    <div class="form-row" id="ds-tv-fields" style="${isKn ? "display:none;" : ""}">
      <label class="form-label">TV Webhook URL</label>
      <input type="text" id="ds-webhook-url" class="form-input" value="${escapeHtml(schedule.webhookUrl || "https://tv-service-alert.kuainiu.chat/alert/v2/array")}" />
    </div>

    <div class="form-row" id="ds-tv-bot-fields" style="${isKn ? "display:none;" : ""}">
      <label class="form-label">TV Bot ID</label>
      <input type="text" id="ds-bot-id" class="form-input" value="${escapeHtml(schedule.botId || "")}" placeholder="填入 TV 机器人 ID" />
    </div>

    <div class="form-row" id="ds-kn-token-fields" style="${isKn ? "" : "display:none;"}">
      <label class="form-label">Bot Token</label>
      <input type="text" id="ds-bot-token" class="form-input" value="${escapeHtml(schedule.botToken || "")}" placeholder="KN Chat Bot Token" />
    </div>

    <div class="form-row" id="ds-kn-chat-fields" style="${isKn ? "" : "display:none;"}">
      <label class="form-label">群聊 Chat ID（可选）</label>
      <input type="text" id="ds-chat-id" class="form-input" value="${escapeHtml(schedule.chatId || "")}" placeholder="多个用逗号分隔" />
    </div>

    <div class="form-row" id="ds-kn-email-fields" style="${isKn ? "" : "display:none;"}">
      <label class="form-label">接收人邮箱（可选）</label>
      <input type="text" id="ds-recipient-emails" class="form-input" value="${escapeHtml(schedule.recipientEmails || "")}" placeholder="多个用逗号分隔" />
    </div>

    <div class="form-row">
      <label class="form-label">@人提醒（可选）</label>
      <input type="text" id="ds-mentions" class="form-input" value="${escapeHtml(schedule.mentions || "")}" placeholder="多个用逗号分隔" />
    </div>

    <div class="form-row form-row-inline">
      <label class="form-checkbox">
        <input type="checkbox" id="ds-send-healthy" ${schedule.sendWhenHealthy ? "checked" : ""} />
        <span>健康时也发送通知</span>
      </label>
    </div>

    <div class="form-row form-row-inline">
      <label class="form-checkbox">
        <input type="checkbox" id="ds-country-detail" ${schedule.includeCountryDetailMessages ? "checked" : ""} />
        <span>按国家分别发送明细</span>
      </label>
    </div>

    <div class="batch-config-actions">
      <button id="ds-notify-save" class="btn btn-primary">💾 保存通知配置</button>
      <button id="ds-notify-test" class="btn">🧪 发送测试消息</button>
      <button id="ds-notify-preview" class="btn">👀 预览消息</button>
      <span id="ds-notify-status" class="ds-save-status"></span>
    </div>

    <div id="ds-notify-preview-area" style="margin-top: 16px; display:none;">
      <div class="batch-config-header">
        <h4>📄 消息预览</h4>
      </div>
      <div id="ds-notify-preview-content" class="notify-preview-box"></div>
    </div>
  `;

  container.querySelector("#ds-notify-channel")?.addEventListener("change", (e) => {
    const isKn = e.target.value === "knBot";
    container.querySelector("#ds-tv-fields").style.display = isKn ? "none" : "";
    container.querySelector("#ds-tv-bot-fields").style.display = isKn ? "none" : "";
    container.querySelector("#ds-kn-token-fields").style.display = isKn ? "" : "none";
    container.querySelector("#ds-kn-chat-fields").style.display = isKn ? "" : "none";
    container.querySelector("#ds-kn-email-fields").style.display = isKn ? "" : "none";
  });

  container.querySelector("#ds-notify-save")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-notify-status");
    statusEl.textContent = "保存中...";
    try {
      const payload = collectDsNotifyForm(container);
      const result = await apiPut("/api/ds-scheduler/schedule", payload);
      dsScheduleCache = result;
      statusEl.textContent = "✓ 已保存";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (error) {
      statusEl.textContent = "✗ " + error.message;
    }
  });

  container.querySelector("#ds-notify-test")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-notify-status");
    statusEl.textContent = "发送中...";
    try {
      const payload = collectDsNotifyForm(container);
      const result = await apiPost("/api/ds-scheduler/notify-test", payload);
      statusEl.textContent = result.ok ? "✓ 测试消息已发送" : "✗ 发送失败";
      setTimeout(() => { statusEl.textContent = ""; }, 3000);
    } catch (error) {
      statusEl.textContent = "✗ " + error.message;
    }
  });

  container.querySelector("#ds-notify-preview")?.addEventListener("click", async () => {
    const previewArea = container.querySelector("#ds-notify-preview-area");
    const previewContent = container.querySelector("#ds-notify-preview-content");
    try {
      const payload = collectDsNotifyForm(container);
      const result = await apiPost("/api/ds-scheduler/notify-preview", payload);
      previewArea.style.display = "";
      const messages = result.messages || [];
      previewContent.innerHTML = messages.map((m, i) => `
        <div class="preview-message">
          <div class="preview-title">${escapeHtml(m.title || "")}</div>
          <pre class="preview-body">${escapeHtml(m.body || "")}</pre>
        </div>
      `).join("");
    } catch (error) {
      previewArea.style.display = "";
      previewContent.innerHTML = `<div class="ds-error">预览失败：${escapeHtml(error.message)}</div>`;
    }
  });
}

function collectDsNotifyForm(container) {
  return {
    notifyChannel: container.querySelector("#ds-notify-channel")?.value || "tv",
    webhookUrl: container.querySelector("#ds-webhook-url")?.value || "",
    botId: container.querySelector("#ds-bot-id")?.value || "",
    botToken: container.querySelector("#ds-bot-token")?.value || "",
    chatId: container.querySelector("#ds-chat-id")?.value || "",
    recipientEmails: container.querySelector("#ds-recipient-emails")?.value || "",
    mentions: container.querySelector("#ds-mentions")?.value || "",
    sendWhenHealthy: container.querySelector("#ds-send-healthy")?.checked || false,
    includeCountryDetailMessages: container.querySelector("#ds-country-detail")?.checked || false,
  };
}

function renderDsScheduleTab(container) {
  container.innerHTML = `
    <div class="batch-config-card">
      <div class="batch-config-header">
        <h3>⏰ 定时巡检配置</h3>
        <p>配置 DS 调度监控的自动巡检时间和国家范围</p>
      </div>
      <div id="ds-schedule-content">
        <div class="ds-loading">加载中...</div>
      </div>
    </div>
  `;
  Promise.all([loadDsSchedule(), apiGet("/api/ds-scheduler/config")]).then(([schedule, config]) => {
    renderDsScheduleForm(container.querySelector("#ds-schedule-content"), schedule || {}, config || {});
  });
}

function renderDsScheduleForm(container, schedule, dsConfig) {
  const countryConfigs = schedule.countryConfigs || [];
  const countryMap = new Map(countryConfigs.map((c) => [String(c.countryCode || "").toUpperCase(), c]));
  const allCountries = COUNTRY_ORDER.map((code) => {
    const existing = countryMap.get(code.toUpperCase()) || {};
    const dsCountry = (dsConfig.countries || {})[code];
    return {
      code,
      name: COUNTRY_LABELS[code],
      flag: COUNTRY_FLAGS[code],
      enabled: Boolean(existing.enabled),
      configured: Boolean(dsCountry?.token),
      notifyChannel: existing.notifyChannel || schedule.notifyChannel || "tv",
      botId: existing.botId || "",
      botToken: existing.botToken || "",
      chatId: existing.chatId || "",
      recipientEmails: existing.recipientEmails || "",
      mentions: existing.mentions || "",
    };
  });

  container.innerHTML = `
    <div class="form-row form-row-inline">
      <label class="form-checkbox">
        <input type="checkbox" id="ds-schedule-enabled" ${schedule.enabled ? "checked" : ""} />
        <span>启用定时巡检</span>
      </label>
    </div>

    <div class="form-row">
      <label class="form-label">巡检频率（分钟）</label>
      <input type="number" id="ds-interval" class="form-input" value="${schedule.intervalMinutes || 60}" min="5" max="1440" />
    </div>

    <div class="form-row">
      <label class="form-label">每日固定运行时间</label>
      <input type="text" id="ds-daily-times" class="form-input" value="${(schedule.dailyRunTimes || []).join(", ")}" placeholder="如：09:00, 15:00, 21:00" />
      <div class="form-hint">多个时间用逗号分隔，24 小时制。启用定时后，系统会按间隔频率 + 固定时间双重触发。</div>
    </div>

    <div class="batch-config-header" style="margin-top: 16px;">
      <h4>🌍 国家巡检配置</h4>
      <p>为每个国家单独设置是否巡检、通知渠道和接收人</p>
    </div>

    <div class="schedule-countries-table">
      ${allCountries.map((c) => `
        <div class="schedule-country-row" data-country="${c.code}">
          <div class="schedule-country-main">
            <label class="form-checkbox schedule-country-checkbox">
              <input type="checkbox" class="schedule-country-enabled" ${c.enabled ? "checked" : ""} ${!c.configured ? "disabled" : ""} />
              <span>${c.flag} ${c.name}</span>
            </label>
            ${!c.configured ? '<span class="ds-badge-sm ds-badge-warn">未配置 Token</span>' : ""}
          </div>
          <div class="schedule-country-detail">
            <select class="schedule-country-notify-channel">
              <option value="tv" ${c.notifyChannel === "tv" ? "selected" : ""}>TV</option>
              <option value="knBot" ${c.notifyChannel === "knBot" ? "selected" : ""}>KN Bot</option>
            </select>
            <input type="text" class="schedule-country-bot-id" placeholder="Bot ID" value="${escapeHtml(c.botId || "")}" style="flex:1;" />
            <input type="text" class="schedule-country-chat-id" placeholder="Chat ID" value="${escapeHtml(c.chatId || "")}" style="flex:1;" />
            <input type="text" class="schedule-country-emails" placeholder="邮箱" value="${escapeHtml(c.recipientEmails || "")}" style="flex:1.5;" />
          </div>
        </div>
      `).join("")}
    </div>

    <div class="batch-config-actions" style="margin-top: 16px;">
      <button id="ds-schedule-save" class="btn btn-primary">💾 保存定时配置</button>
      <button id="ds-schedule-run-now" class="btn">▶️ 立即运行</button>
      <span id="ds-schedule-status" class="ds-save-status"></span>
    </div>
  `;

  container.querySelector("#ds-schedule-save")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-schedule-status");
    statusEl.textContent = "保存中...";
    try {
      const payload = collectDsScheduleForm(container);
      const result = await apiPut("/api/ds-scheduler/schedule", payload);
      dsScheduleCache = result;
      statusEl.textContent = "✓ 已保存";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (error) {
      statusEl.textContent = "✗ " + error.message;
    }
  });

  container.querySelector("#ds-schedule-run-now")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-schedule-status");
    statusEl.textContent = "运行中...";
    try {
      await apiPost("/api/ds-scheduler/schedule/run-now", {});
      statusEl.textContent = "✓ 已开始运行";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (error) {
      statusEl.textContent = "✗ " + error.message;
    }
  });
}

function collectDsScheduleForm(container) {
  const countryRows = container.querySelectorAll(".schedule-country-row");
  const countryConfigs = [];
  countryRows.forEach((row) => {
    const code = row.dataset.country;
    const enabled = row.querySelector(".schedule-country-enabled")?.checked || false;
    const notifyChannel = row.querySelector(".schedule-country-notify-channel")?.value || "tv";
    const botId = row.querySelector(".schedule-country-bot-id")?.value || "";
    const chatId = row.querySelector(".schedule-country-chat-id")?.value || "";
    const recipientEmails = row.querySelector(".schedule-country-emails")?.value || "";
    countryConfigs.push({
      countryCode: code,
      enabled,
      notifyChannel,
      botId,
      chatId,
      recipientEmails,
    });
  });

  return {
    enabled: container.querySelector("#ds-schedule-enabled")?.checked || false,
    intervalMinutes: Number(container.querySelector("#ds-interval")?.value || 60),
    dailyRunTimes: (container.querySelector("#ds-daily-times")?.value || "").split(",").map((t) => t.trim()).filter(Boolean),
    countryConfigs,
  };
}

function renderDsHistoryTab(container) {
  container.innerHTML = `
    <div class="batch-config-card">
      <div class="batch-config-header">
        <h3>📜 运行历史</h3>
        <p>DS 调度巡检的历史运行记录</p>
      </div>
      <div id="ds-history-content">
        <div class="ds-loading">加载中...</div>
      </div>
    </div>
  `;
  loadDsHistory().then((history) => {
    renderDsHistoryList(container.querySelector("#ds-history-content"), history || { runs: [] });
  });
}

function renderDsHistoryList(container, history) {
  const runs = history.runs || [];
  if (runs.length === 0) {
    container.innerHTML = `<div class="ds-empty">暂无运行记录</div>`;
    return;
  }

  container.innerHTML = `
    <div class="ds-history-list">
      ${runs.map((run) => {
        const statusClass = run.status === "success" ? "ds-history-success" : run.status === "failed" ? "ds-history-failed" : "ds-history-partial";
        const statusText = run.status === "success" ? "成功" : run.status === "failed" ? "失败" : "部分失败";
        const triggerText = run.trigger === "schedule" ? "定时" : "手动";
        return `
          <div class="ds-history-item ${statusClass}">
            <div class="ds-history-main">
              <div class="ds-history-time">${formatDsTime(run.startedAt)}</div>
              <div class="ds-history-meta">
                <span class="ds-badge-sm ds-badge-info">${triggerText}</span>
                <span class="ds-badge-sm ${run.status === "success" ? "ds-badge-ok" : "ds-badge-error"}">${statusText}</span>
              </div>
              <div class="ds-history-stats">
                <span>🌐 ${run.countryCount || 0} 国</span>
                <span>📋 ${run.totalChecked || 0} 工作流</span>
                <span>⛔ ${run.totalStuck || 0} 卡死</span>
                <span>⚠️ ${run.totalStale || 0} 离线</span>
                <span>🔔 ${run.notificationSentCount || 0} 条通知</span>
              </div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function formatDsTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}


function renderProjectGrid(root, config) {
  const container = root.querySelector("#ds-project-grid");
  const projectNames = config.projectNames || {};
  const projectCodes = config.projectCodes || {};
  const countries = config.countries || {};

  container.innerHTML = COUNTRY_ORDER.map((code) => {
    const projectName = projectNames[code] || "";
    const projectCode = projectCodes[code] || "";
    const hasToken = Boolean(countries[code]?.token);
    return `
      <div class="ds-project-card ${hasToken ? 'ds-card-active' : 'ds-card-inactive'}">
        <div class="ds-project-head">
          <span class="ds-country-flag">${COUNTRY_FLAGS[code] || "🌍"}</span>
          <div class="ds-project-country">
            <strong>${escapeHtml(COUNTRY_LABELS[code] || code)}</strong>
            <span class="ds-project-status ${hasToken ? 'ds-status-ok' : 'ds-status-off'}">
              ${hasToken ? '✓ 已接入' : '○ 待接入'}
            </span>
          </div>
        </div>
        <div class="ds-project-body">
          <div class="ds-field">
            <label class="ds-field-label">项目名称</label>
            <input class="ds-input ds-project-name" data-country="${escapeHtml(code)}"
                   type="text" value="${escapeHtml(projectName)}" placeholder="如：数据平台" />
          </div>
          ${projectCode ? `
            <div class="ds-project-meta">
              <span class="ds-project-code-label">项目码:</span>
              <code class="ds-project-code">${escapeHtml(projectCode)}</code>
            </div>
          ` : `
            <div class="ds-field-hint">保存后自动匹配项目码</div>
          `}
        </div>
      </div>
    `;
  }).join("");
}

function renderTokenGrid(root, config) {
  const container = root.querySelector("#ds-token-grid");
  const countries = config.countries || {};

  container.innerHTML = COUNTRY_ORDER.map((code) => {
    const c = countries[code] || {};
    return `
      <div class="ds-token-card">
        <div class="ds-token-head">
          <span class="ds-country-flag">${COUNTRY_FLAGS[code] || "🌍"}</span>
          <strong>${escapeHtml(COUNTRY_LABELS[code] || code)}</strong>
        </div>
        <div class="ds-token-body">
          <input class="ds-input ds-country-token" data-country="${escapeHtml(code)}"
                 type="password" value="${escapeHtml(c.token || "")}" placeholder="输入 DS Token" />
        </div>
      </div>
    `;
  }).join("");
}

function setupEventListeners(root) {
  root.querySelector("#ds-save-config")?.addEventListener("click", () => saveConfig(root));
  root.querySelector("#ds-run-check")?.addEventListener("click", () => runCheck(root));

  root.querySelector("#ds-token-toggle")?.addEventListener("click", () => {
    const grid = root.querySelector("#ds-token-grid");
    const arrow = root.querySelector("#ds-token-toggle .ds-toggle-arrow");
    if (grid.style.display === "none") {
      grid.style.display = "grid";
      arrow.textContent = "▼";
    } else {
      grid.style.display = "none";
      arrow.textContent = "▶";
    }
  });
}

async function saveConfig(root) {
  const status = root.querySelector("#ds-save-status");
  status.textContent = "保存中...";
  status.className = "ds-save-status ds-saving";
  try {
    const currentConfig = await apiGet("/api/ds-scheduler/config");
    const projectCards = root.querySelectorAll(".ds-project-card");
    const tokenCards = root.querySelectorAll(".ds-token-card");
    const countries = {};
    const projectNames = {};

    projectCards.forEach((card) => {
      const nameInput = card.querySelector(".ds-project-name");
      const code = nameInput?.dataset?.country;
      if (!code) return;
      projectNames[code] = nameInput?.value?.trim() || "";
    });

    tokenCards.forEach((card) => {
      const tokenInput = card.querySelector(".ds-country-token");
      const code = tokenInput?.dataset?.country;
      if (!code) return;
      const existingToken = currentConfig.countries?.[code]?.token || "";
      const newToken = tokenInput?.value?.trim() || existingToken;
      countries[code] = {
        name: COUNTRY_LABELS[code] || code,
        token: newToken,
      };
    });

    const config = {
      n8nWebhookUrl: "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler",
      projectNames,
      countries,
    };
    const result = await apiPut("/api/ds-scheduler/config", config);
    status.textContent = "✓ 配置已保存" + (result.resolved ? "，已匹配项目代码" : "");
    status.className = "ds-save-status ds-saved";
    const updatedConfig = { ...config, projectCodes: result.projectCodes || {} };
    renderProjectGrid(root, updatedConfig);
    renderTokenGrid(root, updatedConfig);
    setTimeout(() => { status.textContent = ""; }, 3000);
  } catch (error) {
    status.textContent = "✗ 保存失败: " + (error.message || "未知错误");
    status.className = "ds-save-status ds-save-error";
    setTimeout(() => { status.textContent = ""; }, 5000);
  }
}

async function runCheck(root) {
  const status = root.querySelector("#ds-run-check");
  const resultPanel = root.querySelector("#ds-result-panel");
  const resultDiv = root.querySelector("#ds-check-result");
  const origText = status.innerHTML;
  status.disabled = true;
  status.innerHTML = '<span class="btn-spinner"></span> 检查中...';
  resultPanel.style.display = "block";
  resultDiv.innerHTML = `
    <div class="ds-loading-state">
      <div class="ds-loading-spinner"></div>
      <div class="ds-loading-text">正在依次检查 6 个国家，请稍候...</div>
    </div>
  `;
  try {
    const result = await apiPost("/api/ds-scheduler/check");
    status.innerHTML = '<span class="btn-icon">🔄</span> 重新检查';
    updateMetrics(root, result);
    renderCheckResult(resultDiv, result);
  } catch (error) {
    status.innerHTML = origText;
    resultDiv.innerHTML = `
      <div class="ds-error-banner">
        <span class="ds-error-icon">✗</span>
        <div class="ds-error-body">
          <strong>检查失败</strong>
          <p>${escapeHtml(error.message || "网络错误，请确认 n8n 网关地址可访问")}</p>
        </div>
      </div>
    `;
  } finally {
    status.disabled = false;
  }
}

function updateMetrics(root, result) {
  root.querySelector("#ds-metric-countries").textContent = result.totalCountries || 0;
  root.querySelector("#ds-metric-workflows").textContent = result.totalChecked || 0;
  root.querySelector("#ds-metric-stuck").textContent = result.totalStuck || 0;
  root.querySelector("#ds-metric-stale").textContent = result.totalStale || 0;
  root.querySelector("#ds-metric-failed").textContent = result.failedCountries || 0;
}

function renderCheckResult(container, result) {
  const countries = result.countries || [];
  const hasAlerts = countries.some((c) => (c.stuckWorkflows?.length || 0) > 0 || (c.staleWorkflows?.length || 0) > 0);

  let html = `
    <div class="ds-check-meta">
      <span class="ds-check-time">🕐 检查时间: ${new Date(result.checkedAt).toLocaleString()}</span>
    </div>
  `;

  for (const country of countries) {
    const stuckWorkflows = country.stuckWorkflows || [];
    const staleWorkflows = country.staleWorkflows || [];
    const hasIssues = stuckWorkflows.length > 0 || staleWorkflows.length > 0;

    let errorDetail = "";
    if (!country.success && country.error) {
      errorDetail = `
        <div class="ds-error-banner" style="margin: 8px 16px 12px;">
          <span class="ds-error-icon">✗</span>
          <div class="ds-error-body">
            <strong>检查失败</strong>
            <p>${escapeHtml(country.error)}</p>
          </div>
        </div>
      `;
    }

    html += `
      <div class="ds-country-result ${hasIssues ? 'ds-has-issues' : 'ds-all-ok'}">
        <div class="ds-country-result-head">
          <div class="ds-cr-left">
            <span class="ds-country-flag">${COUNTRY_FLAGS[country.country] || "🌍"}</span>
            <strong>${escapeHtml(country.countryName || country.country)}</strong>
            ${country.success ? `<span class="ds-badge ds-badge-ok">✓ 正常</span>` : `<span class="ds-badge ds-badge-error">✗ 失败</span>`}
          </div>
          <div class="ds-cr-stats">
            <span class="ds-chip">📋 ${country.checkedWorkflows || 0} 个工作流</span>
            ${stuckWorkflows.length > 0 ? `<span class="ds-chip ds-chip-danger">⛔ ${stuckWorkflows.length} 卡死</span>` : ""}
            ${staleWorkflows.length > 0 ? `<span class="ds-chip ds-chip-warn">⚠️ ${staleWorkflows.length} 离线</span>` : ""}
            ${!hasIssues && country.success ? `<span class="ds-chip ds-chip-ok">✅ 全部正常</span>` : ""}
          </div>
        </div>
        ${errorDetail}
        ${stuckWorkflows.length > 0 ? renderStuckTable(stuckWorkflows) : ""}
        ${staleWorkflows.length > 0 ? renderStaleTable(staleWorkflows) : ""}
      </div>
    `;
  }

  if (!hasAlerts) {
    html += `
      <div class="ds-all-clear">
        <div class="ds-all-clear-icon">✅</div>
        <div class="ds-all-clear-text">
          <strong>所有国家定时任务均正常</strong>
          <p>未发现卡死工作流或长时间离线任务，所有定时任务运行状态良好。</p>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  requestAnimationFrame(() => {
    container.querySelectorAll(".ds-country-result").forEach((el, i) => {
      el.style.setProperty("--ds-delay", `${i * 0.08}s`);
      el.classList.add("ds-visible");
    });
  });
}

function renderStuckTable(workflows) {
  let html = `
    <div class="ds-issue-section">
      <div class="ds-issue-section-title">
        <span class="ds-issue-icon">⛔</span> 卡死工作流
        <span class="ds-issue-count">${workflows.length} 个</span>
      </div>
      <div class="ds-table-wrap">
        <table class="ds-table">
          <thead>
            <tr>
              <th>工作流名称</th>
              <th>Code</th>
              <th>状态</th>
              <th>异常类型</th>
              <th>详情</th>
              <th>最近失败时间</th>
              <th>负责人</th>
            </tr>
          </thead>
          <tbody>
  `;
  for (const wf of workflows) {
    const recentTimes = (wf.recentFailures || []).slice(0, 2).map((f) => f.schedule_time || f.end_time || "").filter(Boolean);
    const isLongRunning = (wf.stuckType || "").toLowerCase().includes("long_running");
    const issueType = isLongRunning ? "⏱️ 长时间运行" : "❌ 连续失败";
    const issueDetail = isLongRunning ? `已运行 ${wf.runningDuration || "未知"}` : `连续失败 ${wf.consecutiveFailures || 0} 次`;
    const owner = wf.owner || wf.responsible || "-";
    html += `
      <tr>
        <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
        <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
        <td>${wf.scheduleStatus === "ONLINE" ? `<span class="ds-badge-sm ds-badge-ok">ONLINE</span>` : escapeHtml(wf.scheduleStatus || "-")}</td>
        <td><span class="ds-badge-sm ${isLongRunning ? 'ds-badge-warn' : 'ds-badge-error'}">${issueType}</span></td>
        <td>${escapeHtml(issueDetail)}</td>
        <td class="ds-time-cell">${recentTimes.length ? recentTimes.join("<br>") : "-"}</td>
        <td>${escapeHtml(owner)}</td>
      </tr>
    `;
  }
  html += `</tbody></table></div></div>`;
  return html;
}

function renderStaleTable(workflows) {
  let html = `
    <div class="ds-issue-section">
      <div class="ds-issue-section-title">
        <span class="ds-issue-icon">⚠️</span> 离线/旷工任务
        <span class="ds-issue-count">${workflows.length} 个</span>
      </div>
      <div class="ds-table-wrap">
        <table class="ds-table">
          <thead>
            <tr>
              <th>工作流名称</th>
              <th>Code</th>
              <th>状态</th>
              <th>异常类型</th>
              <th>离线时长</th>
              <th>下游依赖</th>
              <th>负责人</th>
            </tr>
          </thead>
          <tbody>
  `;
  for (const wf of workflows) {
    const hasDownstream = wf.downstreamCount && wf.downstreamCount > 0;
    const downstreamInfo = hasDownstream ? `🔗 ${wf.downstreamCount} 个依赖` : "-";
    const owner = wf.owner || wf.responsible || "-";
    const offlineDuration = wf.offlineDuration || wf.staleDuration || "-";
    html += `
      <tr>
        <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
        <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
        <td>${wf.scheduleStatus === "OFFLINE" ? `<span class="ds-badge-sm ds-badge-warn">OFFLINE</span>` : escapeHtml(wf.scheduleStatus || "-")}</td>
        <td><span class="ds-badge-sm ds-badge-warn">💤 异常下线</span></td>
        <td>${escapeHtml(offlineDuration)}</td>
        <td>${hasDownstream ? `<span class="ds-warn-text">${downstreamInfo}</span>` : "-"}</td>
        <td>${escapeHtml(owner)}</td>
      </tr>
    `;
  }
  html += `</tbody></table></div></div>`;
  return html;
}

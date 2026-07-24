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

let dsScheduleCache = null;
let dsHistoryCache = null;
let dsConfigCache = null;
let dsCheckResultCache = null;

async function loadDsConfig() {
  if (!dsConfigCache) {
    dsConfigCache = await apiGet("/api/ds-scheduler/config").catch(() => ({ countries: {} }));
  }
  return dsConfigCache;
}

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

export function renderDsScheduler(root) {
  const activeTab = state.dsTab || "overview";

  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">监控 DolphinScheduler 定时任务连续性，识别卡死和离线任务，支持按国家分发告警通知。</p>
      </div>
      <div class="hero-stats" style="grid-template-columns: repeat(4, minmax(96px, 1fr));">
        <article>
          <span>监控国家</span>
          <strong>6</strong>
        </article>
        <article>
          <span>在检工作流</span>
          <strong id="ds-hero-workflows">—</strong>
        </article>
        <article style="border-color: #fecaca;">
          <span style="color: #b91c1c;">卡死</span>
          <strong style="color: #b91c1c;" id="ds-hero-stuck">—</strong>
        </article>
        <article style="border-color: #fcd34d;">
          <span style="color: #b45309;">离线</span>
          <strong style="color: #b45309;" id="ds-hero-stale">—</strong>
        </article>
      </div>
    </div>

    <div class="workspace-tabs" role="tablist">
      <button class="${activeTab === "overview" ? "active" : ""}" data-ds-tab="overview">
        <strong>📊 总览</strong>
        <span>监控范围、手动检查、结果明细</span>
      </button>
      <button class="${activeTab === "notify" ? "active" : ""}" data-ds-tab="notify">
        <strong>🔔 通知配置</strong>
        <span>告警渠道、接收人、消息预览</span>
      </button>
      <button class="${activeTab === "schedule" ? "active" : ""}" data-ds-tab="schedule">
        <strong>⏰ 定时任务</strong>
        <span>巡检频率、国家范围、立即运行</span>
      </button>
      <button class="${activeTab === "history" ? "active" : ""}" data-ds-tab="history">
        <strong>📜 运行历史</strong>
        <span>历史运行记录和通知统计</span>
      </button>
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
  if (activeTab === "overview") renderDsOverview(tabContent);
  else if (activeTab === "notify") renderDsNotify(tabContent);
  else if (activeTab === "schedule") renderDsSchedule(tabContent);
  else if (activeTab === "history") renderDsHistory(tabContent);
}

// ==================== 总览 Tab ====================

async function renderDsOverview(container) {
  container.innerHTML = `
    <div class="panel">
      <div class="panel-title">
        <strong>🔍 快速巡检</strong>
        <button id="ds-run-check" class="btn btn-primary">
          <span class="btn-icon">▶</span> 执行全面检查
        </button>
      </div>
      <div class="sub-panel">
        <div class="schedule-title-row">
          <div class="section-title">
            <h3>监控说明</h3>
            <p>检查 6 个国家的 DolphinScheduler 定时任务，识别连续失败的卡死任务和异常下线的旷工任务。</p>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px;">
          <div class="anomaly-detail-card">
            <div class="anomaly-detail-card-head">
              <div>
                <strong>⛔ 卡死检测</strong>
                <small>连续失败 / 长时间运行</small>
              </div>
            </div>
            <p style="color: var(--muted); margin-top: 8px; font-size: 13px; line-height: 1.6;">
              工作流连续 N 次运行失败（默认 3 次），或执行时间远超合理范围仍未结束，触发卡死告警。
            </p>
          </div>
          <div class="anomaly-detail-card">
            <div class="anomaly-detail-card-head">
              <div>
                <strong>⚠️ 旷工/离线检测</strong>
                <small>异常下线的工作流</small>
              </div>
            </div>
            <p style="color: var(--muted); margin-top: 8px; font-size: 13px; line-height: 1.6;">
              一周内曾保持上线、且存在下游依赖，但当前突然下线的工作流，判定为异常旷工。
            </p>
          </div>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top: 14px;">
      <div class="panel-title">
        <strong>⚙️ 监控范围配置</strong>
        <button id="ds-save-config" class="btn">
          <span class="btn-icon">💾</span> 保存配置
        </button>
      </div>
      <div id="ds-config-area" class="sub-panel"><div style="color: var(--muted);">加载中...</div></div>
    </div>

    <div id="ds-result-area" style="margin-top: 14px;"></div>
  `;

  loadDsConfig().then((config) => {
    renderDsConfigForm(container.querySelector("#ds-config-area"), config);
  });

  container.querySelector("#ds-run-check")?.addEventListener("click", async () => {
    const resultArea = container.querySelector("#ds-result-area");
    resultArea.innerHTML = `<div class="panel"><div class="sub-panel" style="text-align:center; color: var(--muted); padding: 32px;">⏳ 正在执行全面检查...</div></div>`;
    try {
      const result = await apiPost("/api/ds-scheduler/check", {});
      dsCheckResultCache = result;
      updateDsHeroStats(result);
      renderDsCheckResult(resultArea, result);
    } catch (error) {
      resultArea.innerHTML = `<div class="panel"><div class="sub-panel" style="color: var(--error);">❌ 检查失败：${escapeHtml(error.message)}</div></div>`;
    }
  });

  container.querySelector("#ds-save-config")?.addEventListener("click", async () => {
    const btn = container.querySelector("#ds-save-config");
    const originalText = btn.innerHTML;
    btn.innerHTML = `<span class="btn-icon">⏳</span> 保存中...`;
    btn.disabled = true;
    try {
      const config = collectDsConfig(container);
      const result = await apiPut("/api/ds-scheduler/config", config);
      dsConfigCache = result;
      btn.innerHTML = `<span class="btn-icon">✓</span> 已保存`;
      setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 1500);
    } catch (error) {
      btn.innerHTML = `<span class="btn-icon">✗</span> 保存失败`;
      setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 2000);
    }
  });

  if (dsCheckResultCache) {
    updateDsHeroStats(dsCheckResultCache);
    renderDsCheckResult(container.querySelector("#ds-result-area"), dsCheckResultCache);
  }
}

function updateDsHeroStats(result) {
  const workflows = document.getElementById("ds-hero-workflows");
  const stuck = document.getElementById("ds-hero-stuck");
  const stale = document.getElementById("ds-hero-stale");
  if (workflows) workflows.textContent = result.totalChecked || 0;
  if (stuck) stuck.textContent = result.totalStuck || 0;
  if (stale) stale.textContent = result.totalStale || 0;
}

function renderDsConfigForm(container, config) {
  const countries = config.countries || {};
  const projectNames = config.projectNames || {};
  const projectCodes = config.projectCodes || {};

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
      ${COUNTRY_ORDER.map((code) => {
        const c = countries[code] || {};
        const hasToken = Boolean(c.token);
        const projectName = projectNames[code] || "";
        const projectCode = projectCodes[code] || "";
        return `
          <div class="schedule-country-card ${hasToken ? "is-enabled" : ""}" data-country="${code}">
            <div class="schedule-country-card-header">
              <span>${COUNTRY_FLAGS[code]}</span>
              <strong>${COUNTRY_LABELS[code]}</strong>
              ${hasToken
                ? `<span class="ds-badge-sm ds-badge-ok">已接入</span>`
                : `<span class="ds-badge-sm ds-badge-warn">未配置</span>`}
            </div>
            <label>项目名称</label>
            <input type="text" class="ds-project-input" data-country="${code}" value="${escapeHtml(projectName)}" placeholder="如：数据平台" />
            ${projectCode ? `<div style="font-size: 12px; color: var(--muted); margin-top: 4px;">项目码：<code>${escapeHtml(projectCode)}</code></div>` : ""}
            <label style="margin-top: 8px;">DS Token</label>
            <input type="password" class="ds-token-input" data-country="${code}" value="${escapeHtml(c.token || "")}" placeholder="首次配置时填写" />
          </div>
        `;
      }).join("")}
    </div>
    <div style="margin-top: 12px; padding: 10px 14px; background: #f0f7ff; border-radius: 6px; font-size: 13px; color: #1e40af;">
      💡 先配置项目名称，保存时系统会自动解析出项目码。Token 仅在首次接入时需要填写。
    </div>
  `;
}

function collectDsConfig(container) {
  const config = dsConfigCache || { countries: {}, projectNames: {} };
  const countries = { ...config.countries };
  const projectNames = { ...config.projectNames };

  container.querySelectorAll(".ds-project-input").forEach((input) => {
    const code = input.dataset.country;
    if (code) projectNames[code] = input.value;
  });
  container.querySelectorAll(".ds-token-input").forEach((input) => {
    const code = input.dataset.country;
    if (code && countries[code]) {
      countries[code] = { ...countries[code], token: input.value };
    }
  });

  return { ...config, countries, projectNames };
}

function renderDsCheckResult(container, result) {
  const countries = result.countries || [];
  const hasIssues = countries.some((c) => (c.stuckCount || 0) > 0 || (c.staleCount || 0) > 0 || !c.success);

  let html = `
    <div class="panel">
      <div class="panel-title">
        <strong>📋 检查结果</strong>
        <span style="color: var(--muted); font-size: 13px;">
          ${formatTime(result.checkedAt)}
        </span>
      </div>
  `;

  if (!hasIssues) {
    html += `
      <div class="sub-panel" style="text-align: center; padding: 36px 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">✅</div>
        <strong style="font-size: 15px;">所有国家定时任务均正常</strong>
        <p style="color: var(--muted); margin-top: 6px; font-size: 13px;">未发现卡死工作流或长时间离线任务，所有定时任务运行状态良好。</p>
      </div>
    </div>`;
    container.innerHTML = html;
    return;
  }

  html += `<div class="sub-panel" style="display: grid; gap: 12px;">`;

  for (const country of countries) {
    const stuck = country.stuckWorkflows || [];
    const stale = country.staleWorkflows || [];
    const hasIssue = (country.stuckCount || 0) > 0 || (country.staleCount || 0) > 0 || !country.success;

    html += `
      <div class="entity-card ${country.success ? "" : "ds-entity-error"}">
        <div class="schedule-country-card-header" style="margin-bottom: 10px;">
          <span>${COUNTRY_FLAGS[country.country?.toLowerCase()] || "🌐"}</span>
          <strong>${COUNTRY_LABELS[country.country?.toLowerCase()] || country.countryName || country.country}</strong>
          ${country.success
            ? `<span class="ds-badge-sm ds-badge-ok">正常</span>`
            : `<span class="ds-badge-sm ds-badge-error">检查失败</span>`}
          <span style="margin-left: auto; display: flex; gap: 6px;">
            ${(country.stuckCount || 0) > 0 ? `<span class="ds-badge-sm ds-badge-error">⛔ ${country.stuckCount} 卡死</span>` : ""}
            ${(country.staleCount || 0) > 0 ? `<span class="ds-badge-sm ds-badge-warn">⚠️ ${country.staleCount} 离线</span>` : ""}
            <span class="ds-badge-sm">📋 ${country.checkedWorkflows || 0} 工作流</span>
          </span>
        </div>
    `;

    if (!country.success) {
      html += `<div style="color: var(--error); font-size: 13px; padding: 8px 12px; background: #fef2f2; border-radius: 6px;">❌ ${escapeHtml(country.error || "未知错误")}</div>`;
    }

    if (stuck.length > 0) {
      html += `
        <details open style="margin-top: 8px;">
          <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: #991b1b;">⛔ 卡死工作流（${stuck.length} 个）</summary>
          <div class="ds-table-wrap" style="margin-top: 8px;">
            <table class="ds-table">
              <thead><tr><th>工作流名称</th><th>Code</th><th>状态</th><th>异常类型</th><th>详情</th><th>负责人</th></tr></thead>
              <tbody>
                ${stuck.slice(0, 10).map((wf) => {
                  const isLong = (wf.stuckType || "").toLowerCase().includes("long_running");
                  const type = isLong ? "⏱️ 长时间运行" : "❌ 连续失败";
                  const detail = isLong ? `已运行 ${wf.runningDuration || "未知"}` : `连续失败 ${wf.consecutiveFailures || 0} 次`;
                  return `
                    <tr>
                      <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
                      <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
                      <td>${wf.scheduleStatus === "ONLINE" ? '<span class="ds-badge-sm ds-badge-ok">ONLINE</span>' : escapeHtml(wf.scheduleStatus || "-")}</td>
                      <td><span class="ds-badge-sm ${isLong ? "ds-badge-warn" : "ds-badge-error"}">${type}</span></td>
                      <td>${escapeHtml(detail)}</td>
                      <td>${escapeHtml(wf.owner || wf.responsible || "-")}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </details>
      `;
    }

    if (stale.length > 0) {
      html += `
        <details open style="margin-top: 8px;">
          <summary style="cursor: pointer; font-size: 13px; font-weight: 600; color: #92400e;">⚠️ 离线/旷工任务（${stale.length} 个）</summary>
          <div class="ds-table-wrap" style="margin-top: 8px;">
            <table class="ds-table">
              <thead><tr><th>工作流名称</th><th>Code</th><th>状态</th><th>异常原因</th><th>下游依赖</th><th>负责人</th></tr></thead>
              <tbody>
                ${stale.slice(0, 10).map((wf) => {
                  const hasDown = wf.downstreamCount && wf.downstreamCount > 0;
                  return `
                    <tr>
                      <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
                      <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
                      <td><span class="ds-badge-sm ds-badge-warn">${escapeHtml(wf.scheduleStatus || "OFFLINE")}</span></td>
                      <td>${escapeHtml(wf.staleReason || wf.staleMessage || "异常下线")}</td>
                      <td>${hasDown ? `<span style="color: var(--warning);">🔗 ${wf.downstreamCount} 个依赖</span>` : "-"}</td>
                      <td>${escapeHtml(wf.owner || wf.responsible || "-")}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </details>
      `;
    }

    html += `</div>`;
  }

  html += `</div></div>`;
  container.innerHTML = html;
}

// ==================== 通知配置 Tab ====================

async function renderDsNotify(container) {
  container.innerHTML = `<div class="panel"><div class="sub-panel" style="color: var(--muted);">加载中...</div></div>`;

  const schedule = await loadDsSchedule();
  const sch = schedule || {};
  const channel = sch.notifyChannel || "tv";
  const isKn = channel === "knBot";

  container.innerHTML = `
    <div class="panel">
      <div class="panel-title">
        <strong>🔔 通知渠道配置</strong>
        <div style="display: flex; gap: 8px;">
          <button id="ds-notify-preview" class="btn">👀 预览消息</button>
          <button id="ds-notify-test" class="btn">🧪 发送测试</button>
          <button id="ds-notify-save" class="btn btn-primary">💾 保存配置</button>
        </div>
      </div>
      <div class="sub-panel">
        <div class="ds-config-card">
          <div>
            <label class="ds-form-label">通知渠道</label>
            <select id="ds-notify-channel" class="ds-form-input">
              <option value="tv" ${channel === "tv" ? "selected" : ""}>TV 告警机器人</option>
              <option value="knBot" ${isKn ? "selected" : ""}>KN Chat Bot</option>
            </select>
          </div>
          <div class="tv-target-field" style="${isKn ? "display: none;" : ""}">
            <label class="ds-form-label">TV Webhook</label>
            <input type="text" id="ds-webhook-url" class="ds-form-input" value="${escapeHtml(sch.webhookUrl || "https://tv-service-alert.kuainiu.chat/alert/v2/array")}" />
          </div>
          <div class="tv-target-field" style="${isKn ? "display: none;" : ""}">
            <label class="ds-form-label">TV Bot ID</label>
            <input type="text" id="ds-bot-id" class="ds-form-input" value="${escapeHtml(sch.botId || "")}" placeholder="填入 TV 机器人 ID" />
          </div>
          <div class="kn-target-field" style="${isKn ? "" : "display: none;"}">
            <label class="ds-form-label">Bot Token</label>
            <input type="text" id="ds-bot-token" class="ds-form-input" value="${escapeHtml(sch.botToken || "")}" placeholder="KN Chat Bot Token" />
          </div>
          <div class="kn-target-field" style="${isKn ? "" : "display: none;"}">
            <label class="ds-form-label">群聊 Chat ID</label>
            <input type="text" id="ds-chat-id" class="ds-form-input" value="${escapeHtml(sch.chatId || "")}" placeholder="多个用逗号分隔" />
          </div>
          <div class="kn-target-field" style="${isKn ? "" : "display: none;"}">
            <label class="ds-form-label">接收人邮箱</label>
            <input type="text" id="ds-recipient-emails" class="ds-form-input" value="${escapeHtml(sch.recipientEmails || "")}" placeholder="多个用逗号分隔" />
          </div>
          <div>
            <label class="ds-form-label">@人提醒</label>
            <input type="text" id="ds-mentions" class="ds-form-input" value="${escapeHtml(sch.mentions || "")}" placeholder="多个用逗号分隔" />
          </div>
        </div>

        <div style="display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
            <input type="checkbox" id="ds-send-healthy" ${sch.sendWhenHealthy ? "checked" : ""} />
            健康时也发送通知
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
            <input type="checkbox" id="ds-country-detail" ${sch.includeCountryDetailMessages ? "checked" : ""} />
            按国家分别发送明细消息
          </label>
        </div>

        <div id="ds-notify-status" style="margin-top: 12px; font-size: 13px;"></div>
      </div>
    </div>

    <div id="ds-preview-area" class="panel" style="margin-top: 14px; display: none;">
      <div class="panel-title"><strong>📄 消息预览</strong></div>
      <div id="ds-preview-content" class="sub-panel"></div>
    </div>
  `;

  container.querySelector("#ds-notify-channel")?.addEventListener("change", (e) => {
    const isKn = e.target.value === "knBot";
    container.querySelectorAll(".tv-target-field").forEach((el) => { el.style.display = isKn ? "none" : ""; });
    container.querySelectorAll(".kn-target-field").forEach((el) => { el.style.display = isKn ? "" : "none"; });
  });

  container.querySelector("#ds-notify-save")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-notify-status");
    statusEl.textContent = "⏳ 保存中...";
    statusEl.style.color = "var(--muted)";
    try {
      const payload = collectDsNotify(container);
      const result = await apiPut("/api/ds-scheduler/schedule", payload);
      dsScheduleCache = result;
      statusEl.innerHTML = "<span style='color: #16a34a;'>✓ 已保存</span>";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (error) {
      statusEl.innerHTML = `<span style='color: var(--error);'>✗ ${escapeHtml(error.message)}</span>`;
    }
  });

  container.querySelector("#ds-notify-test")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-notify-status");
    statusEl.textContent = "⏳ 发送中...";
    statusEl.style.color = "var(--muted)";
    try {
      const payload = collectDsNotify(container);
      const result = await apiPost("/api/ds-scheduler/notify-test", payload);
      statusEl.innerHTML = result.ok ? "<span style='color: #16a34a;'>✓ 测试消息已发送</span>" : "<span style='color: var(--error);'>✗ 发送失败</span>";
      setTimeout(() => { statusEl.textContent = ""; }, 3000);
    } catch (error) {
      statusEl.innerHTML = `<span style='color: var(--error);'>✗ ${escapeHtml(error.message)}</span>`;
    }
  });

  container.querySelector("#ds-notify-preview")?.addEventListener("click", async () => {
    const previewArea = container.querySelector("#ds-preview-area");
    const previewContent = container.querySelector("#ds-preview-content");
    try {
      const payload = collectDsNotify(container);
      const result = await apiPost("/api/ds-scheduler/notify-preview", payload);
      previewArea.style.display = "";
      const messages = result.messages || [];
      previewContent.innerHTML = messages.map((m) => `
        <div style="margin-bottom: 16px;">
          <div style="font-weight: 600; margin-bottom: 6px; color: var(--text);">${escapeHtml(m.title || "")}</div>
          <pre style="background: #f8fafc; padding: 12px 16px; border-radius: 8px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid var(--border);">${escapeHtml(m.body || "")}</pre>
        </div>
      `).join("");
    } catch (error) {
      previewArea.style.display = "";
      previewContent.innerHTML = `<div style="color: var(--error);">预览失败：${escapeHtml(error.message)}</div>`;
    }
  });
}

function collectDsNotify(container) {
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

// ==================== 定时任务 Tab ====================

async function renderDsSchedule(container) {
  container.innerHTML = `<div class="panel"><div class="sub-panel" style="color: var(--muted);">加载中...</div></div>`;

  const [schedule, dsConfig] = await Promise.all([loadDsSchedule(), loadDsConfig()]);
  const sch = schedule || {};
  const countryConfigs = sch.countryConfigs || [];
  const countryMap = new Map(countryConfigs.map((c) => [String(c.countryCode || "").toUpperCase(), c]));

  const allCountries = COUNTRY_ORDER.map((code) => {
    const existing = countryMap.get(code.toUpperCase()) || {};
    const dsCountry = (dsConfig.countries || {})[code];
    const configured = Boolean(dsCountry?.token);
    const countryChannel = existing.notifyChannel || sch.notifyChannel || "tv";
    return {
      code,
      name: COUNTRY_LABELS[code],
      flag: COUNTRY_FLAGS[code],
      enabled: configured && Boolean(existing.enabled),
      configured,
      notifyChannel: countryChannel,
      botId: existing.botId || "",
      botToken: existing.botToken || "",
      chatId: existing.chatId || "",
      recipientEmails: existing.recipientEmails || "",
      mentions: existing.mentions || "",
    };
  });

  container.innerHTML = `
    <div class="panel">
      <div class="panel-title">
        <strong>⏰ 定时巡检配置</strong>
        <div style="display: flex; gap: 8px;">
          <button id="ds-run-now" class="btn">▶️ 立即运行</button>
          <button id="ds-save-schedule" class="btn btn-primary">💾 保存配置</button>
        </div>
      </div>
      <div class="sub-panel">
        <div class="ds-config-card" style="display: grid; grid-template-columns: auto 1fr 2fr; gap: 14px; align-items: start;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; white-space: nowrap;">
            <input type="checkbox" id="ds-schedule-enabled" ${sch.enabled ? "checked" : ""} />
            启用定时巡检
          </label>
          <div>
            <label class="ds-form-label">巡检间隔（分钟）</label>
            <input type="number" id="ds-interval" class="ds-form-input" value="${sch.intervalMinutes || 60}" min="5" max="1440" />
          </div>
          <div>
            <label class="ds-form-label">每日固定运行时间</label>
            <input type="text" id="ds-daily-times" class="ds-form-input" value="${(sch.dailyRunTimes || []).join(", ")}" placeholder="如：09:00, 15:00, 21:00" />
          </div>
        </div>
        <div style="font-size: 12px; color: var(--muted); margin-top: 8px;">
          💡 多个时间用逗号分隔，24 小时制。系统会按间隔频率 + 固定时间点双重触发。
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top: 14px;">
      <div class="panel-title">
        <strong>🌍 国家巡检范围</strong>
        <span style="color: var(--muted); font-size: 13px;">为每个国家分别配置是否巡检和通知目标</span>
      </div>
      <div class="sub-panel">
        <div class="schedule-country-section">
          <div class="compact-header">
            <strong>按国家配置</strong>
            <p>启用的国家才会参与定时巡检，未配置 Token 的国家无法启用。</p>
          </div>
        </div>
        <div class="schedule-country-grid">
          ${allCountries.map((c) => `
            <div class="schedule-country-card ${c.enabled ? "is-enabled" : ""}" data-country="${c.code}" data-notify-channel="${c.notifyChannel}">
              <div class="schedule-country-card-header">
                <span>${c.flag}</span>
                <strong>${c.name}</strong>
                ${c.configured
                  ? `<label class="mini-switch">
                      <input type="checkbox" class="schedule-country-enabled" ${c.enabled ? "checked" : ""} />
                      <span>${c.enabled ? "已启用" : "未启用"}</span>
                    </label>`
                  : `<span class="ds-badge-sm ds-badge-warn">未配置 Token</span>`}
              </div>
              <select class="schedule-country-notify-channel">
                <option value="tv" ${c.notifyChannel === "tv" ? "selected" : ""}>TV 机器人</option>
                <option value="knBot" ${c.notifyChannel === "knBot" ? "selected" : ""}>KN Bot</option>
              </select>
              <input type="text" class="tv-target-field schedule-country-bot-id" placeholder="Bot ID" value="${escapeHtml(c.botId || "")}" style="${c.notifyChannel === "knBot" ? "display: none;" : ""}" />
              <input type="text" class="kn-target-field schedule-country-chat-id" placeholder="Chat ID" value="${escapeHtml(c.chatId || "")}" style="${c.notifyChannel === "knBot" ? "" : "display: none;"}" />
              <input type="text" class="kn-target-field schedule-country-emails" placeholder="接收邮箱" value="${escapeHtml(c.recipientEmails || "")}" style="${c.notifyChannel === "knBot" ? "" : "display: none;"}" />
            </div>
          `).join("")}
        </div>
      </div>
    </div>

    <div id="ds-schedule-status" style="margin-top: 12px; font-size: 13px;"></div>
  `;

  // 国家卡片的开关和渠道切换
  container.querySelectorAll(".schedule-country-enabled").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const card = e.target.closest(".schedule-country-card");
      if (card) {
        if (e.target.checked) card.classList.add("is-enabled");
        else card.classList.remove("is-enabled");
      }
    });
  });

  container.querySelectorAll(".schedule-country-notify-channel").forEach((select) => {
    select.addEventListener("change", (e) => {
      const card = e.target.closest(".schedule-country-card");
      if (!card) return;
      const channel = e.target.value;
      card.dataset.notifyChannel = channel;
      card.querySelectorAll(".tv-target-field").forEach((el) => { el.style.display = channel === "tv" ? "" : "none"; });
      card.querySelectorAll(".kn-target-field").forEach((el) => { el.style.display = channel === "knBot" ? "" : "none"; });
    });
  });

  container.querySelector("#ds-save-schedule")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-schedule-status");
    statusEl.textContent = "⏳ 保存中...";
    statusEl.style.color = "var(--muted)";
    try {
      const payload = collectDsSchedule(container);
      const result = await apiPut("/api/ds-scheduler/schedule", payload);
      dsScheduleCache = result;
      statusEl.innerHTML = "<span style='color: #16a34a;'>✓ 已保存</span>";
      setTimeout(() => { statusEl.textContent = ""; }, 2000);
    } catch (error) {
      statusEl.innerHTML = `<span style='color: var(--error);'>✗ ${escapeHtml(error.message)}</span>`;
    }
  });

  container.querySelector("#ds-run-now")?.addEventListener("click", async () => {
    const statusEl = container.querySelector("#ds-schedule-status");
    statusEl.textContent = "⏳ 开始运行...";
    statusEl.style.color = "var(--muted)";
    try {
      await apiPost("/api/ds-scheduler/schedule/run-now", {});
      statusEl.innerHTML = "<span style='color: #16a34a;'>✓ 已开始运行，可在历史页面查看结果</span>";
      dsHistoryCache = null;
      setTimeout(() => { statusEl.textContent = ""; }, 3000);
    } catch (error) {
      statusEl.innerHTML = `<span style='color: var(--error);'>✗ ${escapeHtml(error.message)}</span>`;
    }
  });
}

function collectDsSchedule(container) {
  const countryCards = container.querySelectorAll(".schedule-country-card");
  const countryConfigs = [];
  countryCards.forEach((card) => {
    const code = card.dataset.country;
    const enabled = card.querySelector(".schedule-country-enabled")?.checked || false;
    const notifyChannel = card.querySelector(".schedule-country-notify-channel")?.value || "tv";
    const botId = card.querySelector(".schedule-country-bot-id")?.value || "";
    const chatId = card.querySelector(".schedule-country-chat-id")?.value || "";
    const recipientEmails = card.querySelector(".schedule-country-emails")?.value || "";
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

// ==================== 历史 Tab ====================

async function renderDsHistory(container) {
  container.innerHTML = `<div class="panel"><div class="sub-panel" style="color: var(--muted);">加载中...</div></div>`;

  const history = await loadDsHistory();
  const runs = history.runs || [];

  if (runs.length === 0) {
    container.innerHTML = `
      <div class="panel">
        <div class="sub-panel" style="text-align: center; padding: 48px 20px;">
          <div style="font-size: 40px; margin-bottom: 10px;">📭</div>
          <strong style="font-size: 15px;">暂无运行记录</strong>
          <p style="color: var(--muted); margin-top: 6px; font-size: 13px;">配置定时任务或手动运行后，历史记录会显示在这里。</p>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="panel">
      <div class="panel-title">
        <strong>📜 运行历史</strong>
        <span style="color: var(--muted); font-size: 13px;">共 ${runs.length} 条记录</span>
      </div>
      <div class="sub-panel" style="padding: 0;">
        <div class="ds-table-wrap">
          <table class="ds-table">
            <thead>
              <tr>
                <th>运行时间</th>
                <th>触发方式</th>
                <th>状态</th>
                <th>国家</th>
                <th>工作流</th>
                <th>卡死</th>
                <th>离线</th>
                <th>通知数</th>
              </tr>
            </thead>
            <tbody>
              ${runs.map((run) => {
                const statusMap = {
                  success: { label: "成功", cls: "ds-badge-ok" },
                  partial_failed: { label: "部分失败", cls: "ds-badge-warn" },
                  failed: { label: "失败", cls: "ds-badge-error" },
                };
                const s = statusMap[run.status] || { label: run.status, cls: "" };
                const triggerLabel = run.trigger === "schedule" ? "⏰ 定时" : "👆 手动";
                return `
                  <tr>
                    <td>${formatTime(run.startedAt)}</td>
                    <td>${triggerLabel}</td>
                    <td><span class="ds-badge-sm ${s.cls}">${s.label}</span></td>
                    <td>${run.countryCount || 0}</td>
                    <td>${run.totalChecked || 0}</td>
                    <td><span style="color: ${run.totalStuck ? "var(--error)" : "inherit"};">${run.totalStuck || 0}</span></td>
                    <td><span style="color: ${run.totalStale ? "var(--warning)" : "inherit"};">${run.totalStale || 0}</span></td>
                    <td>${run.notificationSentCount || 0}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// ==================== 工具函数 ====================

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

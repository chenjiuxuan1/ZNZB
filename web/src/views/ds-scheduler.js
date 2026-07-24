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

function buildDsSchedulerHtml(root) {
  const activeTab = state.dsTab || "overview";

  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">监控 DolphinScheduler 定时任务连续性，识别卡死和离线任务，支持按国家分发告警通知。</p>
      </div>
      ${renderDsHeroStats()}
    </div>
    ${renderDsWorkspaceTabs(activeTab)}
    ${activeTab === "overview" ? renderDsOverviewPanel(root) : ""}
    ${activeTab === "notify" ? renderDsNotifyPanel(root) : ""}
    ${activeTab === "schedule" ? renderDsSchedulePanel(root) : ""}
    ${activeTab === "history" ? renderDsHistoryPanel(root) : ""}
  `;

  root.querySelectorAll("[data-ds-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dsTab = button.dataset.dsTab;
      renderDsScheduler(root);
    });
  });
}

function renderDsHeroStats() {
  const result = dsCheckResultCache || {};
  const stuck = result.totalStuck || 0;
  const stale = result.totalStale || 0;
  const workflows = result.totalChecked || "—";
  return `
    <div class="hero-stats" style="grid-template-columns: repeat(4, minmax(96px, 1fr));">
      <article>
        <span>监控国家</span>
        <strong>6</strong>
      </article>
      <article>
        <span>在检工作流</span>
        <strong>${workflows}</strong>
      </article>
      <article style="${stuck ? "border-color: #fecaca; background: #fff7f7;" : ""}">
        <span style="${stuck ? "color: #b91c1c;" : ""}">卡死</span>
        <strong style="${stuck ? "color: #b91c1c;" : ""}">${stuck}</strong>
      </article>
      <article style="${stale ? "border-color: #fcd34d; background: #fffbeb;" : ""}">
        <span style="${stale ? "color: #b45309;" : ""}">离线</span>
        <strong style="${stale ? "color: #b45309;" : ""}">${stale}</strong>
      </article>
    </div>
  `;
}

function renderDsWorkspaceTabs(activeTab) {
  const tabs = [
    { key: "overview", label: "总览检查", detail: "监控范围与手动巡检", index: "01" },
    { key: "notify", label: "通知配置", detail: "告警渠道与消息预览", index: "02" },
    { key: "schedule", label: "定时任务", detail: "定点运行与国家范围", index: "03" },
    { key: "history", label: "历史明细", detail: "每次运行记录查看", index: "04" },
  ];
  return `
    <div class="workspace-tabs" role="tablist">
      ${tabs.map((tab) => `
        <button class="${activeTab === tab.key ? "active" : ""}" data-ds-tab="${escapeHtml(tab.key)}" type="button">
          <small>${escapeHtml(tab.index)}</small>
          <strong>${escapeHtml(tab.label)}</strong>
          <span>${escapeHtml(tab.detail)}</span>
        </button>
      `).join("")}
    </div>
  `;
}

// ==================== 总览 Tab ====================

function renderDsOverviewPanel(root) {
  const config = dsConfigCache;
  const result = dsCheckResultCache;

  return `
    <section class="panel batch-controls">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">手动检查</h2>
          <p class="muted">一次性检查所有国家的 DS 调度状态，发现异常可立即通知。</p>
        </div>
        <button class="primary" id="ds-run-check">执行全面检查</button>
      </div>

      <div class="notice compact-notice">
        <strong>检查说明</strong>
        <span>会对 6 个国家逐一调用 n8n 网关检查卡死和离线任务；未配置 Token 的国家自动跳过。</span>
      </div>

      <div class="manual-check-grid">
        <div class="sub-panel">
          <h2 class="panel-title">监控范围</h2>
          <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px;">
            ${COUNTRY_ORDER.map((code) => {
              const c = (config?.countries || {})[code] || {};
              const hasToken = Boolean(c.token);
              return `
                <div style="display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: ${hasToken ? "#f0fdf4" : "#f9fafb"}; border: 1px solid ${hasToken ? "#bbf7d0" : "var(--border)"}; border-radius: 6px;">
                  <span style="font-size: 18px;">${COUNTRY_FLAGS[code]}</span>
                  <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; font-size: 13px;">${COUNTRY_LABELS[code]}</div>
                    <div style="font-size: 11px; color: ${hasToken ? "#16a34a" : "var(--muted)"};">${hasToken ? "✓ 已接入" : "未配置 Token"}</div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
        <div class="sub-panel">
          <h2 class="panel-title">项目映射</h2>
          <div style="margin-top: 12px;">
            <p class="muted" style="margin-bottom: 10px;">配置国家对应的 DS 项目名称，系统自动解析项目码。Token 在下方折叠区域配置。</p>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;">
              ${COUNTRY_ORDER.map((code) => {
                const projectName = (config?.projectNames || {})[code] || "";
                const projectCode = (config?.projectCodes || {})[code] || "";
                return `
                  <div style="font-size: 12px;">
                    <div style="font-weight: 500; margin-bottom: 4px;">${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</div>
                    <div style="color: var(--muted);">${projectName ? projectName : "未配置"}${projectCode ? ` → <code>${projectCode}</code>` : ""}</div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        </div>
      </div>

      <div id="ds-result-area">
        ${result ? renderDsCheckResult(result) : `<p class="muted">点击"执行全面检查"开始巡检。</p>`}
      </div>
    </section>
  `;
}

// 事件绑定在 render 后统一处理
function renderDsCheckResult(result) {
  const countries = result.countries || [];
  const hasIssues = countries.some((c) => (c.stuckCount || 0) > 0 || (c.staleCount || 0) > 0 || !c.success);

  if (!hasIssues && result.totalChecked > 0) {
    return `
      <div class="sandbox-status success">
        <strong>✅ 所有国家定时任务均正常</strong>
        <span>检查 ${result.totalChecked} 个工作流，未发现卡死或离线任务。</span>
      </div>
    `;
  }

  let html = `<div class="schedule-country-section">`;
  html += `<div class="detail-header compact-header"><h2 class="panel-title">检查结果</h2><p class="muted">${formatTime(result.checkedAt)} · 共 ${result.totalChecked} 个工作流</p></div>`;
  html += `<div class="schedule-country-grid">`;

  for (const country of countries) {
    const code = country.country?.toLowerCase() || "";
    const stuck = country.stuckWorkflows || [];
    const stale = country.staleWorkflows || [];
    const isOk = country.success && (country.stuckCount || 0) === 0 && (country.staleCount || 0) === 0;

    html += `
      <article class="schedule-country-card ${!isOk ? "is-enabled" : ""}" style="opacity: 1;">
        <div class="schedule-country-card-header">
          <div>
            <strong>${COUNTRY_FLAGS[code] || "🌐"} ${COUNTRY_LABELS[code] || country.countryName || country.country}</strong>
            <span class="badge ${country.success ? (isOk ? "ok" : "warn") : "danger"}">${country.success ? (isOk ? "正常" : "有异常") : "检查失败"}</span>
          </div>
          <div style="font-size: 12px; color: var(--muted);">📋 ${country.checkedWorkflows || 0} 个工作流</div>
        </div>
    `;

    if (!country.success) {
      html += `<div style="background: #fef2f2; color: #991b1b; padding: 8px 10px; border-radius: 6px; font-size: 12px; margin-top: 8px;">❌ ${escapeHtml(country.error || "未知错误")}</div>`;
    }

    if (stuck.length > 0) {
      html += `
        <div style="margin-top: 8px;">
          <div style="font-size: 12px; font-weight: 600; color: #991b1b; margin-bottom: 4px;">⛔ 卡死（${stuck.length}）</div>
          ${stuck.slice(0, 3).map((wf) => {
            const detail = wf.consecutiveFailures ? `连续失败 ${wf.consecutiveFailures} 次` : "运行超时";
            return `<div style="font-size: 12px; padding: 4px 0; color: #374151;">• ${escapeHtml(wf.workflowName || wf.workflowCode)} <span style="color: var(--muted)">(${detail})</span></div>`;
          }).join("")}
          ${stuck.length > 3 ? `<div style="font-size: 11px; color: var(--muted);">还有 ${stuck.length - 3} 个...</div>` : ""}
        </div>
      `;
    }

    if (stale.length > 0) {
      html += `
        <div style="margin-top: 8px;">
          <div style="font-size: 12px; font-weight: 600; color: #92400e; margin-bottom: 4px;">⚠️ 离线（${stale.length}）</div>
          ${stale.slice(0, 3).map((wf) => `
            <div style="font-size: 12px; padding: 4px 0; color: #374151;">• ${escapeHtml(wf.workflowName || wf.workflowCode)} <span style="color: var(--muted)">(${escapeHtml(wf.staleReason || wf.staleMessage || "异常下线")})</span></div>
          `).join("")}
          ${stale.length > 3 ? `<div style="font-size: 11px; color: var(--muted);">还有 ${stale.length - 3} 个...</div>` : ""}
        </div>
      `;
    }

    html += `</article>`;
  }

  html += `</div></div>`;
  return html;
}

// ==================== 通知配置 Tab ====================

function renderDsNotifyPanel(root) {
  const schedule = dsScheduleCache || {};
  const channel = schedule.notifyChannel || "tv";
  const isKn = channel === "knBot";

  return `
    <section class="panel schedule-panel">
      <div class="schedule-title-row">
        <div>
          <h2 class="panel-title section-title">通知配置</h2>
          <p class="muted">配置 DS 调度异常的告警通知渠道和接收人，支持 TV 机器人和 KN Chat Bot。</p>
        </div>
        <div class="button-group">
          <button id="ds-notify-preview" class="secondary">预览消息</button>
          <button id="ds-notify-test" class="secondary">发送测试</button>
          <button id="ds-notify-save" class="primary">保存配置</button>
        </div>
      </div>

      <div class="schedule-config-card">
        <label>
          通知渠道
          <select id="ds-notify-channel">
            <option value="tv" ${channel === "tv" ? "selected" : ""}>TV webhook</option>
            <option value="knBot" ${isKn ? "selected" : ""}>KN Chat 机器人</option>
          </select>
        </label>
        <label class="tv-target-field">
          TV webhook 地址
          <input id="ds-webhook-url" value="${escapeHtml(schedule.webhookUrl || "https://tv-service-alert.kuainiu.chat/alert/v2/array")}" />
        </label>
        <label class="tv-target-field">
          TV bot_id
          <input id="ds-bot-id" value="${escapeHtml(schedule.botId || "")}" placeholder="必填：TV 机器人 ID" />
        </label>
        <label class="tv-target-field">
          TV 提醒人
          <input id="ds-mentions" value="${escapeHtml(schedule.mentions || "")}" placeholder="可选，多个用逗号分隔" />
        </label>
        <label class="kn-target-field">
          Bot Token
          <input id="ds-bot-token" value="${escapeHtml(schedule.botToken || "")}" placeholder="KN Chat Bot Token" />
        </label>
        <label class="kn-target-field">
          群聊 Chat ID
          <input id="ds-chat-id" value="${escapeHtml(schedule.chatId || "")}" placeholder="可选，多个用逗号分隔" />
        </label>
        <label class="kn-target-field">
          接收人邮箱
          <input id="ds-recipient-emails" value="${escapeHtml(schedule.recipientEmails || "")}" placeholder="可选，多个用逗号分隔" />
        </label>
      </div>

      <div class="schedule-help">
        <strong>选项说明</strong>
        <span>「健康时也发送」在无异常时仍然推送一条正常消息；「按国家分发明细」每个国家单独发一条，方便不同国家的值班同学各自接收。</span>
      </div>

      <div style="display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
          <input type="checkbox" id="ds-send-healthy" ${schedule.sendWhenHealthy ? "checked" : ""} />
          健康时也发送通知
        </label>
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
          <input type="checkbox" id="ds-country-detail" ${schedule.includeCountryDetailMessages ? "checked" : ""} />
          按国家分别发送明细消息
        </label>
      </div>

      <div id="ds-notify-status" style="margin-top: 12px;"></div>
      <div id="ds-preview-area" style="margin-top: 14px; display: none;">
        <div class="detail-header compact-header"><h2 class="panel-title">消息预览</h2><p class="muted">使用模拟数据生成</p></div>
        <div id="ds-preview-content" style="margin-top: 10px;"></div>
      </div>
    </section>
  `;
}

// ==================== 定时任务 Tab ====================

function renderDsSchedulePanel(root) {
  const schedule = dsScheduleCache || {};
  const config = dsConfigCache || {};
  const enabled = Boolean(schedule.enabled);
  const countryConfigs = schedule.countryConfigs || [];
  const configMap = new Map(countryConfigs.map((c) => [String(c.countryCode || "").toUpperCase(), c]));

  const countries = COUNTRY_ORDER.map((code) => {
    const existing = configMap.get(code.toUpperCase()) || {};
    const dsCountry = (config.countries || {})[code];
    const configured = Boolean(dsCountry?.token);
    return {
      code, name: COUNTRY_LABELS[code], flag: COUNTRY_FLAGS[code],
      enabled: configured && Boolean(existing.enabled),
      configured,
      notifyChannel: existing.notifyChannel || schedule.notifyChannel || "tv",
      botId: existing.botId || "",
      botToken: existing.botToken || "",
      chatId: existing.chatId || "",
      recipientEmails: existing.recipientEmails || "",
      mentions: existing.mentions || "",
    };
  });

  const lastRunText = schedule.lastRunAt ? formatTime(schedule.lastRunAt) : "—";
  const nextRunText = (schedule.enabled && schedule.nextRunAt) ? formatTime(schedule.nextRunAt) : "未启用";
  const enabledCopy = enabled
    ? "已开启，到点会自动巡检已上线国家"
    : "已关闭，不会自动触发；仍可手动测试";
  const dailyTimesValue = (schedule.dailyRunTimes || []).join(", ");

  return `
    <section class="panel schedule-panel">
      <div class="schedule-title-row">
        <div>
          <h2 class="panel-title section-title">定时巡检</h2>
          <p class="muted">按国家配置自动巡检。总开关控制是否到点自动运行，国家开关控制该国家是否参与。</p>
        </div>
        <div class="button-group">
          <button id="ds-save-schedule" class="secondary">保存配置</button>
          <button id="ds-run-now" class="primary">立即运行测试</button>
        </div>
      </div>

      <div class="schedule-config-card">
        <label class="switch-field">
          <input id="ds-schedule-enabled" type="checkbox" ${enabled ? "checked" : ""}>
          <span class="switch-track"></span>
          <span>
            <strong>自动触发</strong>
            <small id="ds-schedule-enabled-copy">${enabledCopy}</small>
          </span>
        </label>
        <div class="field">
          <label>巡检间隔（分钟）</label>
          <input type="number" id="ds-interval" value="${schedule.intervalMinutes || 60}" min="5" max="1440" />
          <small class="muted">两次巡检之间的最小间隔，范围 5-1440 分钟。</small>
        </div>
        <div class="field">
          <label>每日运行时间（北京时间，可多个）</label>
          <input id="ds-daily-times" value="${escapeHtml(dailyTimesValue)}" placeholder="例如：09:00, 15:00, 21:00" />
          <small class="muted">多个时间用逗号分隔；每天会在这些时间点各运行一次。</small>
        </div>
        <div class="field">
          <label>下次运行</label>
          <input value="${escapeHtml(nextRunText)}" readonly>
        </div>
        <div class="field">
          <label>上次运行</label>
          <input value="${escapeHtml(lastRunText)}" readonly>
        </div>
      </div>

      <div class="schedule-help">
        <strong>怎么下线</strong>
        <span>关闭"自动触发"并保存，会停止所有到点自动巡检；关闭某个国家卡片里的"上线"并保存，只会下线该国家。选择 KN Chat 机器人时填接收人邮箱；选择 TV webhook 时填写 TV bot_id。</span>
      </div>

      <div class="schedule-country-section">
        <div class="detail-header compact-header">
          <h2 class="panel-title">国家定时配置</h2>
          <p class="muted">每个国家可以独立上下线和配置通知方式。</p>
        </div>
        <div class="schedule-country-grid">
          ${countries.map((c) => {
            const rowEnabled = c.enabled;
            return `
              <article class="schedule-country-row schedule-country-card ${rowEnabled ? "is-enabled" : ""}" data-country-code="${c.code}" data-notify-channel="${c.notifyChannel}">
                <div class="schedule-country-card-header">
                  <div>
                    <strong>${c.flag} ${c.name}</strong>
                    <span class="badge schedule-country-state ${rowEnabled ? "ok" : "danger"}">${rowEnabled ? "已上线" : (c.configured ? "未上线" : "未配置")}</span>
                  </div>
                  <label class="mini-switch">
                    <input class="schedule-country-enabled" type="checkbox" ${rowEnabled ? "checked" : ""} ${c.configured ? "" : "disabled"}>
                    <span></span>
                    <em>上线</em>
                  </label>
                </div>
                <label>
                  通知方式
                  <select class="schedule-country-notify-channel">
                    <option value="tv" ${c.notifyChannel === "tv" ? "selected" : ""}>TV webhook</option>
                    <option value="knBot" ${c.notifyChannel === "knBot" ? "selected" : ""}>KN Chat 机器人</option>
                  </select>
                </label>
                <label class="kn-target-field">
                  接收人邮箱
                  <input class="schedule-country-recipient-emails" value="${escapeHtml(c.recipientEmails || "")}" placeholder="多个邮箱用逗号分隔">
                </label>
                <label class="tv-target-field">
                  TV bot_id
                  <input class="schedule-country-bot-id" value="${escapeHtml(c.botId || "")}" placeholder="TV bot_id">
                </label>
                <label class="tv-target-field">
                  TV 提醒人
                  <input class="schedule-country-mentions" value="${escapeHtml(c.mentions || "")}" placeholder="多个用逗号分隔">
                </label>
                <p class="muted-inline kn-target-field">KN Chat 会按邮箱私聊，无需填写提醒人。</p>
              </article>
            `;
          }).join("")}
        </div>
      </div>

      <div id="ds-schedule-status" style="margin-top: 12px;"></div>
    </section>
  `;
}

// ==================== 历史 Tab ====================

function renderDsHistoryPanel(root) {
  const history = dsHistoryCache || { runs: [] };
  const runs = history.runs || [];

  return `
    <section class="panel schedule-history-panel">
      <div class="detail-header compact-header">
        <h2 class="panel-title">运行历史</h2>
        <p class="muted">最近 50 条巡检记录，按时间倒序排列。</p>
      </div>

      ${runs.length === 0 ? `
        <div style="text-align: center; padding: 48px 20px;">
          <div style="font-size: 36px; margin-bottom: 8px;">📭</div>
          <strong style="font-size: 14px;">暂无运行记录</strong>
          <p class="muted" style="margin-top: 6px;">配置定时任务或手动运行后，历史记录会显示在这里。</p>
        </div>
      ` : `
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
                  success: { label: "成功", cls: "ok" },
                  partial_failed: { label: "部分失败", cls: "warn" },
                  failed: { label: "失败", cls: "danger" },
                };
                const s = statusMap[run.status] || { label: run.status || "-", cls: "" };
                const triggerLabel = run.trigger === "schedule" ? "⏰ 定时" : "👆 手动";
                return `
                  <tr>
                    <td>${formatTime(run.startedAt)}</td>
                    <td>${triggerLabel}</td>
                    <td><span class="badge ${s.cls}">${s.label}</span></td>
                    <td>${run.countryCount || 0}</td>
                    <td>${run.totalChecked || 0}</td>
                    <td style="color: ${run.totalStuck ? "var(--error)" : "inherit"};">${run.totalStuck || 0}</td>
                    <td style="color: ${run.totalStale ? "#b45309" : "inherit"};">${run.totalStale || 0}</td>
                    <td>${run.notificationSentCount || 0}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `}
    </section>
  `;
}

// ==================== 事件绑定（重写 renderDsScheduler 以支持事件） ====================

let dsDataLoading = false;

export function renderDsScheduler(root) {
  buildDsSchedulerHtml(root);
  bindDsEvents(root);

  // 首屏并行加载所有数据，加载完后重渲染一次
  if (!dsDataLoading) {
    dsDataLoading = true;
    Promise.allSettled([
      loadDsConfig(),
      loadDsSchedule(),
      loadDsHistory(),
    ]).then(() => {
      dsDataLoading = false;
      buildDsSchedulerHtml(root);
      bindDsEvents(root);
    });
  }

function bindDsEvents(root) {
  // 总览 - 执行检查
  root.querySelector("#ds-run-check")?.addEventListener("click", async () => {
    const resultArea = root.querySelector("#ds-result-area");
    if (resultArea) {
      resultArea.innerHTML = `<div class="sandbox-status running"><strong>⏳ 正在执行全面检查...</strong><span>请稍候，正在检查 6 个国家。</span></div>`;
    }
    try {
      const result = await apiPost("/api/ds-scheduler/check", {});
      dsCheckResultCache = result;
      renderDsScheduler(root);
    } catch (error) {
      if (resultArea) {
        resultArea.innerHTML = `<div class="sandbox-status error"><strong>❌ 检查失败</strong><span>${escapeHtml(error.message)}</span></div>`;
      }
    }
  });

  // 通知配置 - 渠道切换
  root.querySelector("#ds-notify-channel")?.addEventListener("change", (e) => {
    const isKn = e.target.value === "knBot";
    root.querySelectorAll(".kn-target-field").forEach((el) => {
      if (el.tagName === "LABEL" || el.classList.contains("field")) {
        el.style.display = isKn ? "" : "none";
      }
    });
    root.querySelectorAll(".tv-target-field").forEach((el) => {
      if (el.tagName === "LABEL" || el.classList.contains("field")) {
        el.style.display = isKn ? "none" : "";
      }
    });
  });

  // 通知配置 - 保存
  root.querySelector("#ds-notify-save")?.addEventListener("click", async () => {
    const statusEl = root.querySelector("#ds-notify-status");
    if (statusEl) statusEl.innerHTML = `<div class="sandbox-status running"><strong>⏳</strong><span>保存中...</span></div>`;
    try {
      const payload = collectDsNotify(root);
      const result = await apiPut("/api/ds-scheduler/schedule", payload);
      dsScheduleCache = result;
      if (statusEl) statusEl.innerHTML = `<div class="sandbox-status success"><strong>✓</strong><span>已保存</span></div>`;
      setTimeout(() => renderDsScheduler(root), 800);
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<div class="sandbox-status error"><strong>✗ 保存失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  });

  // 通知配置 - 测试
  root.querySelector("#ds-notify-test")?.addEventListener("click", async () => {
    const statusEl = root.querySelector("#ds-notify-status");
    if (statusEl) statusEl.innerHTML = `<div class="sandbox-status running"><strong>⏳</strong><span>发送中...</span></div>`;
    try {
      const payload = collectDsNotify(root);
      const result = await apiPost("/api/ds-scheduler/notify-test", payload);
      if (statusEl) statusEl.innerHTML = result.ok
        ? `<div class="sandbox-status success"><strong>✓</strong><span>测试消息已发送</span></div>`
        : `<div class="sandbox-status error"><strong>✗</strong><span>发送失败</span></div>`;
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<div class="sandbox-status error"><strong>✗</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  });

  // 通知配置 - 预览
  root.querySelector("#ds-notify-preview")?.addEventListener("click", async () => {
    const previewArea = root.querySelector("#ds-preview-area");
    const previewContent = root.querySelector("#ds-preview-content");
    if (!previewArea || !previewContent) return;
    try {
      const payload = collectDsNotify(root);
      const result = await apiPost("/api/ds-scheduler/notify-preview", payload);
      previewArea.style.display = "";
      const messages = result.messages || [];
      previewContent.innerHTML = messages.map((m) => `
        <div style="margin-bottom: 14px;">
          <div style="font-weight: 600; margin-bottom: 6px; font-size: 13px;">${escapeHtml(m.title || "")}</div>
          <pre style="background: #f9fafb; padding: 12px 14px; border-radius: 6px; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; border: 1px solid var(--border);">${escapeHtml(m.body || "")}</pre>
        </div>
      `).join("");
    } catch (error) {
      previewArea.style.display = "";
      previewContent.innerHTML = `<div class="sandbox-status error"><strong>预览失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  });

  // 定时任务 - 国家开关
  root.querySelectorAll(".schedule-country-enabled").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const card = e.target.closest(".schedule-country-card");
      if (!card) return;
      if (e.target.checked) card.classList.add("is-enabled");
      else card.classList.remove("is-enabled");
      const badge = card.querySelector(".schedule-country-state");
      if (badge) {
        badge.textContent = e.target.checked ? "已上线" : "未上线";
        badge.className = "badge schedule-country-state " + (e.target.checked ? "ok" : "danger");
      }
    });
  });

  // 定时任务 - 国家渠道切换
  root.querySelectorAll(".schedule-country-notify-channel").forEach((select) => {
    select.addEventListener("change", (e) => {
      const card = e.target.closest(".schedule-country-card");
      if (!card) return;
      const channel = e.target.value;
      card.dataset.notifyChannel = channel;
    });
  });

  // 定时任务 - 总开关文案
  root.querySelector("#ds-schedule-enabled")?.addEventListener("change", (e) => {
    const copy = root.querySelector("#ds-schedule-enabled-copy");
    if (copy) {
      copy.textContent = e.target.checked
        ? "已开启，到点会自动巡检已上线国家"
        : "已关闭，不会自动触发；仍可手动测试";
    }
  });

  // 定时任务 - 保存
  root.querySelector("#ds-save-schedule")?.addEventListener("click", async () => {
    const statusEl = root.querySelector("#ds-schedule-status");
    if (statusEl) statusEl.innerHTML = `<div class="sandbox-status running"><strong>⏳</strong><span>保存中...</span></div>`;
    try {
      const payload = collectDsSchedule(root);
      const result = await apiPut("/api/ds-scheduler/schedule", payload);
      dsScheduleCache = result;
      if (statusEl) statusEl.innerHTML = `<div class="sandbox-status success"><strong>✓</strong><span>已保存</span></div>`;
      setTimeout(() => renderDsScheduler(root), 800);
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<div class="sandbox-status error"><strong>✗ 保存失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  });

  // 定时任务 - 立即运行
  root.querySelector("#ds-run-now")?.addEventListener("click", async () => {
    const statusEl = root.querySelector("#ds-schedule-status");
    if (statusEl) statusEl.innerHTML = `<div class="sandbox-status running"><strong>⏳</strong><span>开始运行，可在历史页面查看结果</span></div>`;
    try {
      await apiPost("/api/ds-scheduler/schedule/run-now", {});
      dsHistoryCache = null;
      setTimeout(() => renderDsScheduler(root), 1000);
    } catch (error) {
      if (statusEl) statusEl.innerHTML = `<div class="sandbox-status error"><strong>✗</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  });
}

}

// ==================== 数据收集函数 ====================

function collectDsNotify(root) {
  return {
    notifyChannel: root.querySelector("#ds-notify-channel")?.value || "tv",
    webhookUrl: root.querySelector("#ds-webhook-url")?.value || "",
    botId: root.querySelector("#ds-bot-id")?.value || "",
    botToken: root.querySelector("#ds-bot-token")?.value || "",
    chatId: root.querySelector("#ds-chat-id")?.value || "",
    recipientEmails: root.querySelector("#ds-recipient-emails")?.value || "",
    mentions: root.querySelector("#ds-mentions")?.value || "",
    sendWhenHealthy: root.querySelector("#ds-send-healthy")?.checked || false,
    includeCountryDetailMessages: root.querySelector("#ds-country-detail")?.checked || false,
  };
}

function collectDsSchedule(root) {
  const countryCards = root.querySelectorAll(".schedule-country-card");
  const countryConfigs = [];
  countryCards.forEach((card) => {
    const code = card.dataset.countryCode;
    if (!code) return;
    const enabled = card.querySelector(".schedule-country-enabled")?.checked || false;
    const notifyChannel = card.querySelector(".schedule-country-notify-channel")?.value || "tv";
    const botId = card.querySelector(".schedule-country-bot-id")?.value || "";
    const recipientEmails = card.querySelector(".schedule-country-recipient-emails")?.value || "";
    const mentions = card.querySelector(".schedule-country-mentions")?.value || "";
    countryConfigs.push({
      countryCode: code,
      enabled,
      notifyChannel,
      botId,
      recipientEmails,
      mentions,
    });
  });

  return {
    enabled: root.querySelector("#ds-schedule-enabled")?.checked || false,
    intervalMinutes: Number(root.querySelector("#ds-interval")?.value || 60),
    dailyRunTimes: (root.querySelector("#ds-daily-times")?.value || "").split(/[,，]+/).map((t) => t.trim()).filter(Boolean),
    countryConfigs,
  };
}

// ==================== 工具函数 ====================

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

import { apiGet, apiPut, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml, json } from "../view-utils.js";

const COUNTRY_LABELS = {
  cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥",
};
const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];

export function renderDsScheduler(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">监控 DolphinScheduler 定时任务连续性，识别"失败后一直失败"的卡死工作流</p>
      </div>
    </div>

    <div class="notice">
      <strong>监控说明</strong>
      <span>DS 调度监控会定期检查 6 个国家（中国、印尼、菲律宾、泰国、巴基斯坦、墨西哥）的 DolphinScheduler 定时任务。
      对于每个已上线（ONLINE）的定时工作流，从最新一次调度实例开始，检查是否有连续 N 次（默认 3 次）运行失败。
      如果连续失败次数达到阈值，则判定为"卡死"（stuck）并告警。</span>
    </div>

    <div class="ds-scheduler-layout">
      <section class="panel">
        <h2 class="panel-title">监控范围</h2>
        <div id="ds-monitor-scope"></div>
      </section>

      <section class="panel">
        <h2 class="panel-title">检查结果</h2>
        <div class="check-actions">
          <button id="ds-run-check" class="btn btn-primary">执行全面检查</button>
          <span id="ds-check-status" class="save-status"></span>
        </div>
        <div id="ds-check-result"></div>
      </section>

      <section class="panel">
        <h2 class="panel-title">连接配置</h2>
        <details>
          <summary style="cursor:pointer;color:var(--text-secondary);font-size:14px;">点击管理 n8n Webhook 地址和各国 DS Token</summary>
          <div class="config-form" style="margin-top:12px;">
            <label class="field">
              <span>n8n Webhook 地址</span>
              <input id="ds-webhook-url" type="text" class="input" placeholder="https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" />
            </label>
            <div class="country-tokens">
              <h3>各国 Token</h3>
              <div id="ds-country-tokens"></div>
            </div>
            <div class="form-actions">
              <button id="ds-save-config" class="btn btn-primary">保存配置</button>
              <span id="ds-save-status" class="save-status"></span>
            </div>
          </div>
        </details>
      </section>
    </div>
  `;
  loadConfig(root);
  setupEventListeners(root);
}

async function loadConfig(root) {
  try {
    const config = await apiGet("/api/ds-scheduler/config");
    root.querySelector("#ds-webhook-url").value = config.n8nWebhookUrl || "";
    renderCountryTokens(root, config.countries || {});
    renderMonitorScope(root, config);
  } catch (error) {
    console.error("load config error:", error);
  }
}

function renderMonitorScope(root, config) {
  const container = root.querySelector("#ds-monitor-scope");
  const countries = config.countries || {};
  const configured = COUNTRY_ORDER.filter((code) => {
    const c = countries[code];
    return c && c.token && c.token.length > 0;
  });
  const unconfigured = COUNTRY_ORDER.filter((code) => !configured.includes(code));

  let html = `
    <div class="scope-summary">
      <div class="summary-card">
        <span class="summary-value">${configured.length}</span>
        <span class="summary-label">已配置国家</span>
      </div>
      <div class="summary-card ${unconfigured.length > 0 ? 'warning' : 'ok'}">
        <span class="summary-value">${unconfigured.length}</span>
        <span class="summary-label">未配置国家</span>
      </div>
    </div>
    <div class="scope-detail">
      <h3>已配置监控范围</h3>
      <div class="country-scope-grid">
        ${configured.map((code) => {
          const c = countries[code];
          return `
            <div class="scope-card ok">
              <strong>${escapeHtml(COUNTRY_LABELS[code] || code)}</strong>
              <span class="scope-status">✓ Token 已配置</span>
              <span class="scope-project">项目 code: ${escapeHtml(c.projectCode || "default")}</span>
            </div>
          `;
        }).join("")}
      </div>
      ${unconfigured.length > 0 ? `
        <h3>未配置（需在连接配置中补充 Token）</h3>
        <div class="country-scope-grid">
          ${unconfigured.map((code) => `
            <div class="scope-card unconfigured">
              <strong>${escapeHtml(COUNTRY_LABELS[code] || code)}</strong>
              <span class="scope-status">✗ 未配置</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
  container.innerHTML = html;
}

function renderCountryTokens(root, countries) {
  const container = root.querySelector("#ds-country-tokens");
  container.innerHTML = COUNTRY_ORDER.map((code) => {
    const country = countries[code] || {};
    return `
      <div class="country-token-row">
        <label class="country-label">${escapeHtml(COUNTRY_LABELS[code] || code)}</label>
        <input class="input ds-country-token" data-country="${escapeHtml(code)}" 
               type="password" value="${escapeHtml(country.token || "")}" 
               placeholder="DS Token" />
        <button class="btn btn-sm toggle-token" data-target="ds-token-${escapeHtml(code)}">显示</button>
      </div>
    `;
  }).join("");
}

function setupEventListeners(root) {
  root.querySelector("#ds-save-config")?.addEventListener("click", () => saveConfig(root));
  root.querySelector("#ds-run-check")?.addEventListener("click", () => runCheck(root));
  root.addEventListener("click", (event) => {
    if (event.target.classList.contains("toggle-token")) {
      const row = event.target.closest(".country-token-row");
      const input = row?.querySelector(".ds-country-token");
      if (input) {
        input.type = input.type === "password" ? "text" : "password";
        event.target.textContent = input.type === "password" ? "显示" : "隐藏";
      }
    }
  });
}

async function saveConfig(root) {
  const status = root.querySelector("#ds-save-status");
  status.textContent = "保存中...";
  try {
    const webhookUrl = root.querySelector("#ds-webhook-url").value.trim();
    const countryInputs = root.querySelectorAll(".ds-country-token");
    const countries = {};
    countryInputs.forEach((input) => {
      const code = input.dataset.country;
      countries[code] = {
        name: COUNTRY_LABELS[code] || code,
        token: input.value.trim(),
      };
    });
    const config = { n8nWebhookUrl: webhookUrl, countries };
    await apiPut("/api/ds-scheduler/config", config);
    status.textContent = "✓ 已保存";
    renderMonitorScope(root, config);
    setTimeout(() => { status.textContent = ""; }, 3000);
  } catch (error) {
    status.textContent = "✗ 保存失败: " + error.message;
  }
}

async function runCheck(root) {
  const status = root.querySelector("#ds-check-status");
  const resultDiv = root.querySelector("#ds-check-result");
  status.textContent = "检查中...";
  resultDiv.innerHTML = '<div class="loading">正在依次检查 6 个国家，请稍候...</div>';
  try {
    const result = await apiPost("/api/ds-scheduler/check");
    status.textContent = `✓ 完成 (${new Date(result.checkedAt).toLocaleString()})`;
    renderCheckResult(resultDiv, result);
  } catch (error) {
    status.textContent = "✗ 检查失败: " + error.message;
    resultDiv.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

function renderCheckResult(container, result) {
  const countries = result.countries || [];
  const totalStuck = result.totalStuck || 0;
  const totalChecked = result.totalChecked || 0;
  const failedCount = result.failedCountries || 0;

  let html = `
    <div class="result-summary">
      <div class="summary-card">
        <span class="summary-value">${result.totalCountries || 0}</span>
        <span class="summary-label">国家</span>
      </div>
      <div class="summary-card">
        <span class="summary-value">${totalChecked}</span>
        <span class="summary-label">检查的工作流</span>
      </div>
      <div class="summary-card ${totalStuck > 0 ? 'alert' : 'ok'}">
        <span class="summary-value">${totalStuck}</span>
        <span class="summary-label">卡死工作流</span>
      </div>
      <div class="summary-card ${failedCount > 0 ? 'warning' : 'ok'}">
        <span class="summary-value">${failedCount}</span>
        <span class="summary-label">检查失败国家</span>
      </div>
    </div>
  `;

  for (const country of countries) {
    const stuckWorkflows = country.stuckWorkflows || [];
    const statusIcon = country.success ? "✓" : "✗";
    const statusClass = country.success ? "ok" : "error";
    const stuckBadge = country.stuckCount > 0
      ? `<span class="badge badge-alert">${country.stuckCount} 个卡死</span>`
      : `<span class="badge badge-ok">正常</span>`;

    html += `
      <div class="country-result">
        <div class="country-result-header ${statusClass}">
          <strong>${escapeHtml(country.countryName || country.country)}</strong>
          ${stuckBadge}
          <span>${country.checkedWorkflows || 0} 个工作流 | ${statusIcon} ${country.success ? "成功" : escapeHtml(country.error || "失败")}</span>
        </div>
        ${stuckWorkflows.length > 0
          ? renderStuckTable(stuckWorkflows)
          : '<div class="country-result-body" style="color:var(--text-secondary);padding:8px 12px;">✅ 所有定时工作流最近一次运行均正常，无连续失败</div>'}
      </div>
    `;
  }

  if (totalStuck > 0) {
    html += `
      <div class="notice" style="margin-top:16px;">
        <strong>ⓘ 卡死说明</strong>
        <span>连续失败次数达到阈值（默认 3 次）的工作流被标记为"卡死"。建议检查工作流定义、数据源连接、任务脚本是否有变更，或联系对应国家负责人排查。</span>
      </div>
    `;
  }

  container.innerHTML = html;
}

function renderStuckTable(workflows) {
  let html = `<table class="data-table"><thead><tr>
    <th>工作流名称</th><th>Code</th><th>定时状态</th><th>连续失败</th><th>检查总数</th><th>最近失败时间</th>
  </tr></thead><tbody>`;
  for (const wf of workflows) {
    const recentFailures = (wf.recentFailures || []).slice(0, 3);
    const failureTimes = recentFailures
      .map((f) => f.schedule_time || f.end_time || "")
      .filter(Boolean)
      .join("<br>") || "-";
    html += `<tr>
      <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
      <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
      <td>${wf.scheduleStatus === "ONLINE" ? '<span class="badge badge-ok">ONLINE</span>' : escapeHtml(wf.scheduleStatus || "-")}</td>
      <td class="alert"><strong>${wf.consecutiveFailures || 0}</strong></td>
      <td>${wf.totalChecked || 0}</td>
      <td><small>${failureTimes}</small></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

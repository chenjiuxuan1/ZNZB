import { apiGet, apiPut, apiPost } from "../api.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_LABELS = {
  cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥",
};
const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];

const COUNTRY_FLAGS = {
  cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽",
};

export function renderDsScheduler(root) {
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
              <p>对每个已上线（ONLINE）的定时工作流，从最新调度实例开始，检查是否有连续 N 次（默认 3 次）运行失败。连续失败次数达到阈值则判定为"卡死"并告警。</p>
            </div>
          </div>
          <div class="ds-info-feature">
            <span class="ds-feature-icon">⚠️</span>
            <div>
              <strong>旷工/离线检测</strong>
              <p>识别已下线（OFFLINE）或长时间未运行的定时任务。如果工作流之前是定时上线状态，但被误触下线后长时间未运行，系统会识别并提醒。</p>
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
        <!-- 左侧：项目配置（主要展示） -->
        <div class="ds-project-config-area">
          <h3 class="ds-area-title">📁 国家项目映射</h3>
          <div class="ds-project-grid" id="ds-project-grid"></div>
        </div>
        <!-- 右侧：Token 配置（次要，折叠或紧凑展示） -->
        <div class="ds-token-config-area">
          <div class="ds-token-toggle" id="ds-token-toggle">
            <span>🔑 DS Token 配置</span>
            <span class="ds-toggle-arrow">▶</span>
          </div>
          <div class="ds-token-grid" id="ds-token-grid" style="display: none;"></div>
        </div>
      </div>
      <div class="ds-config-hint">
        <span class="hint-icon">💡</span>
        <span>首先在左侧配置项目名称，系统自动匹配项目码。Token 仅在首次配置时需要填写。</span>
      </div>
    </div>

    <!-- 检查结果区域 -->
    <div class="ds-section" id="ds-result-panel" style="display:none;">
      <div class="ds-section-header">
        <div class="ds-section-title">
          <span class="ds-section-icon">📊</span>
          <span>检查结果</span>
        </div>
      </div>
      <div id="ds-check-result" class="ds-check-result"></div>
    </div>
  `;
  loadConfig(root);
  setupEventListeners(root);
}

async function loadConfig(root) {
  try {
    const config = await apiGet("/api/ds-scheduler/config");
    renderProjectGrid(root, config);
    renderTokenGrid(root, config);
  } catch (error) {
    console.error("load config error:", error);
  }
}

// 渲染项目配置网格（左侧）
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

// 渲染 Token 配置网格（右侧）
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

  // Token toggle
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

    // 收集项目名称
    projectCards.forEach((card) => {
      const nameInput = card.querySelector(".ds-project-name");
      const code = nameInput?.dataset?.country;
      if (!code) return;
      projectNames[code] = nameInput?.value?.trim() || "";
    });

    // 收集 token（如果没有填写，保留原来的）
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
    // Re-render with updated project codes
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
              <th>连续失败</th>
              <th>检查数</th>
              <th>最近失败时间</th>
            </tr>
          </thead>
          <tbody>
  `;
  for (const wf of workflows) {
    const recentTimes = (wf.recentFailures || []).slice(0, 2).map((f) => f.schedule_time || f.end_time || "").filter(Boolean);
    html += `
      <tr>
        <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
        <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
        <td>${wf.scheduleStatus === "ONLINE" ? `<span class="ds-badge-sm ds-badge-ok">ONLINE</span>` : escapeHtml(wf.scheduleStatus || "-")}</td>
        <td><span class="ds-danger-text">${wf.consecutiveFailures || 0} 次</span></td>
        <td>${wf.totalChecked || 0}</td>
        <td class="ds-time-cell">${recentTimes.length ? recentTimes.join("<br>") : "-"}</td>
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
              <th>离线原因</th>
            </tr>
          </thead>
          <tbody>
  `;
  for (const wf of workflows) {
    html += `
      <tr>
        <td><strong>${escapeHtml(wf.workflowName || "-")}</strong></td>
        <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
        <td>${wf.scheduleStatus === "OFFLINE" ? `<span class="ds-badge-sm ds-badge-warn">OFFLINE</span>` : escapeHtml(wf.scheduleStatus || "-")}</td>
        <td><span class="ds-warn-text">${escapeHtml(wf.staleMessage || wf.staleReason || "-")}</span></td>
      </tr>
    `;
  }
  html += `</tbody></table></div></div>`;
  return html;
}

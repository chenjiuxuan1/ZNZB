import { apiGet, apiPut, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml, json } from "../view-utils.js";

export function renderDsScheduler(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">配置 DolphinScheduler 各国 Token，执行定时任务连续失败检查。</p>
      </div>
    </div>
    <div class="ds-scheduler-layout">
      <section class="panel">
        <h2 class="panel-title">配置</h2>
        <div class="config-form">
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
      </section>
      <section class="panel">
        <h2 class="panel-title">检查</h2>
        <div class="check-actions">
          <button id="ds-run-check" class="btn btn-primary">执行全面检查</button>
          <span id="ds-check-status" class="save-status"></span>
        </div>
        <div id="ds-check-result"></div>
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
  } catch (error) {
    console.error("load config error:", error);
  }
}

function renderCountryTokens(root, countries) {
  const container = root.querySelector("#ds-country-tokens");
  const countryOrder = ["cn", "ine", "ph", "th", "pk", "mx"];
  const countryLabels = {
    cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥",
  };
  container.innerHTML = countryOrder.map((code) => {
    const country = countries[code] || {};
    return `
      <div class="country-token-row">
        <label class="country-label">${escapeHtml(countryLabels[code] || code)}</label>
        <input class="input ds-country-token" data-country="${escapeHtml(code)}" 
               type="password" value="${escapeHtml(country.token || "")}" 
               placeholder="DS Token" />
        <button class="btn btn-sm toggle-token" data-target="ds-country-token-${escapeHtml(code)}">显示</button>
        <input class="input ds-country-name" data-country="${escapeHtml(code)}" 
               type="text" value="${escapeHtml(country.name || countryLabels[code] || code)}" 
               placeholder="国家名称" style="width:100px;margin-left:8px;" />
      </div>
    `;
  }).join("");
}

function setupEventListeners(root) {
  root.querySelector("#ds-save-config")?.addEventListener("click", () => saveConfig(root));
  root.querySelector("#ds-run-check")?.addEventListener("click", () => runCheck(root));
  root.addEventListener("click", (event) => {
    if (event.target.classList.contains("toggle-token")) {
      const input = event.target.parentElement.querySelector(".ds-country-token");
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
    const nameInputs = root.querySelectorAll(".ds-country-name");
    const countries = {};
    countryInputs.forEach((input) => {
      const code = input.dataset.country;
      const nameInput = Array.from(nameInputs).find((n) => n.dataset.country === code);
      countries[code] = {
        name: nameInput ? nameInput.value.trim() : code,
        token: input.value.trim(),
      };
    });
    await apiPut("/api/ds-scheduler/config", { n8nWebhookUrl: webhookUrl, countries });
    status.textContent = "✓ 已保存";
    setTimeout(() => { status.textContent = ""; }, 3000);
  } catch (error) {
    status.textContent = "✗ 保存失败: " + error.message;
  }
}

async function runCheck(root) {
  const status = root.querySelector("#ds-check-status");
  const resultDiv = root.querySelector("#ds-check-result");
  status.textContent = "检查中...";
  resultDiv.innerHTML = "";
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
  const totalCountries = result.totalCountries || 0;
  const failedCountries = result.failedCountries || 0;
  const totalStuck = result.totalStuck || 0;
  const countries = result.countries || [];

  let html = `
    <div class="result-summary">
      <div class="summary-card">
        <span class="summary-value">${totalCountries}</span>
        <span class="summary-label">国家</span>
      </div>
      <div class="summary-card ${failedCountries > 0 ? 'warning' : 'ok'}">
        <span class="summary-value">${failedCountries}</span>
        <span class="summary-label">失败</span>
      </div>
      <div class="summary-card ${totalStuck > 0 ? 'alert' : 'ok'}">
        <span class="summary-value">${totalStuck}</span>
        <span class="summary-label">Stuck 工作流</span>
      </div>
    </div>
  `;

  for (const country of countries) {
    const stuckWorkflows = country.stuckWorkflows || [];
    html += `
      <div class="country-result">
        <div class="country-result-header ${country.success ? 'ok' : 'error'}">
          <strong>${escapeHtml(country.countryName || country.country)}</strong>
          <span>${country.success ? '✓ 成功' : '✗ ' + escapeHtml(country.error || '失败')}</span>
          <span>${country.checkedWorkflows || 0} 个工作流 | ${country.stuckCount || 0} 个 stuck</span>
        </div>
        ${stuckWorkflows.length > 0 ? renderStuckTable(stuckWorkflows) : '<div class="country-result-body">无连续失败</div>'}
      </div>
    `;
  }

  container.innerHTML = html;
}

function renderStuckTable(workflows) {
  let html = `<table class="data-table"><thead><tr>
    <th>工作流名称</th><th>Code</th><th>定时状态</th><th>连续失败</th><th>检查总数</th><th>最近失败</th>
  </tr></thead><tbody>`;
  for (const wf of workflows) {
    const recentFailures = (wf.recentFailures || []).slice(0, 3);
    const failureInfo = recentFailures.map((f) =>
      `${f.schedule_time || ""} (${f.state || ""})`
    ).join("<br>") || "-";
    html += `<tr>
      <td>${escapeHtml(wf.workflowName || "-")}</td>
      <td><code>${escapeHtml(wf.workflowCode || "")}</code></td>
      <td>${escapeHtml(wf.scheduleStatus || "-")}</td>
      <td class="alert">${wf.consecutiveFailures || 0}</td>
      <td>${wf.totalChecked || 0}</td>
      <td><small>${failureInfo}</small></td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

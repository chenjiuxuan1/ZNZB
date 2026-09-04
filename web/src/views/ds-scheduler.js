import { apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";
import { renderLegacyMigrationBanner } from "./alert-center/legacy-migration-banner.js";

const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const COUNTRY_FLAGS = { cn: "🇨🇳", ine: "🇮🇩", ph: "🇵🇭", th: "🇹🇭", pk: "🇵🇰", mx: "🇲🇽" };
let model = { config: {}, result: null, status: null, history: null, saving: false };

export function summarizeDsCountryCheck(country = {}) {
  const stuck = Number(country.stuckCount || 0);
  const stale = Number(country.staleCount || 0);
  const failed = Number(country.failedCount || 0);
  const success = country.success !== false;
  const hasIssue = !success || stuck > 0 || stale > 0 || failed > 0;
  return {
    stuck,
    stale,
    failed,
    hasIssue,
    badgeClass: !success ? "danger" : (hasIssue ? "warn" : "ok"),
    badgeText: !success ? "检查失败" : (hasIssue ? "有异常" : "正常"),
    summary: `检查 ${country.checkedWorkflows || 0} 个工作流 · 卡死 ${stuck} · 无运行记录 ${stale} · 执行失败 ${failed}`,
  };
}

export function renderDsScheduler(root) {
  root.innerHTML = `${renderLegacyMigrationBanner("rules")}<section class="panel"><p class="muted">正在加载 DS 调度配置…</p></section>`;
  load(root);
}

async function load(root) {
  try {
    model.config = await apiGet("/api/ds-scheduler/config");
  } catch (error) {
    model.status = { type: "error", text: `DS 配置加载失败：${error.message}` };
  }
  try {
    model.history = await apiGet("/api/ds-scheduler/history?limit=20");
  } catch {
    model.history = null;
  }
  paint(root);
}

function paint(root) {
  const result = model.result;
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">DS 调度监控</h1>
        <p class="page-note">配置各国 DolphinScheduler 项目并执行只读测试；正式巡检由定时巡检统一调度和通知。</p>
      </div>
      <div class="hero-stats">
        ${stat("已匹配项目", resolvedCount())}
        ${stat("测试工作流", result?.totalChecked ?? "—")}
        ${stat("卡死 / 未运行 / 执行失败", result ? `${result.totalStuck || 0} / ${result.totalStale || 0} / ${result.totalFailed || 0}` : "—")}
        ${stat("检查失败", result?.failedCountries ?? "—")}
      </div>
    </div>
    ${renderLegacyMigrationBanner("rules")}
    ${renderStatus()}
    <section class="panel ds-config-section">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">项目配置</h2>
          <p class="muted">可填写多个项目名称，用逗号、分号或换行分隔；系统逐个匹配，项目码不会在页面展示。</p>
        </div>
        <div class="button-group">
          <button id="ds-save-projects">保存项目配置</button>
          <button class="primary" id="ds-run-test">执行 DS 测试</button>
        </div>
      </div>
      <div class="notice compact-notice">
        <strong>正式巡检入口</strong>
        <span>请在 <a href="#/batch-check">定时巡检</a> 中开启“同时执行 DS 调度巡检”。通知渠道、KN Chat Bot Token 和接收人完全使用巡检配置。</span>
      </div>
      <div class="schedule-country-grid ds-project-grid">
        ${COUNTRY_ORDER.map((code) => renderProjectCard(code)).join("")}
      </div>
      <details class="advanced compact ds-token-details">
        <summary>高级：DS Token 与 n8n 网关</summary>
        <div class="ds-project-fields ds-gateway-field">
          <label>n8n webhook<input id="ds-webhook-url" value="${escapeHtml(model.config.n8nWebhookUrl || "http://127.0.0.1:5678/webhook/ds-scheduler")}"></label>
        </div>
        <div class="schedule-country-grid ds-token-grid">
          ${COUNTRY_ORDER.map((code) => `<label>${COUNTRY_LABELS[code]} Token<input class="ds-country-token" data-country="${code}" type="password" value="${escapeHtml(model.config.countries?.[code]?.token || "")}" placeholder="首次配置时填写"></label>`).join("")}
        </div>
      </details>
    </section>
    ${renderResult()}
    ${renderHistory()}
  `;
  root.querySelector("#ds-save-projects")?.addEventListener("click", () => saveProjects(root));
  root.querySelector("#ds-run-test")?.addEventListener("click", () => runTest(root));
}

function setButtonBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    btn.dataset.prevLabel = btn.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="btn-spinner"></span>${busyLabel}`;
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = btn.dataset.prevLabel || busyLabel;
  }
}

function scrollStatusIntoView(root) {
  root.querySelector(".sandbox-status")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderProjectCard(code) {
  const country = model.config.countries?.[code] || {};
  const status = model.config.projectStatus?.[code] || {};
  const resolved = status.status === "resolved";
  return `
    <article class="schedule-country-card ds-project-card" data-country="${code}">
      <div class="schedule-country-card-header">
        <div><strong>${COUNTRY_FLAGS[code]} ${COUNTRY_LABELS[code]}</strong>
          <span class="badge ${resolved && country.token ? "ok" : "warn"}">${resolved && country.token ? "已接入" : "待匹配"}</span>
        </div>
      </div>
      <div class="ds-project-fields ds-project-name-only">
        <label>项目名称（可多个）<input class="ds-project-name" value="${escapeHtml(model.config.projectNames?.[code] || "")}" placeholder="如：数据平台，风控平台"></label>
      </div>
      ${(status.projects || []).length ? `<div class="project-match-list">${status.projects.map((item) => `<span class="badge ${item.code ? "ok" : "warn"}">${escapeHtml(item.name)} · ${item.code ? "已匹配" : "待匹配"}</span>`).join("")}</div>` : ""}
      ${status.error ? `<p class="field-error">${escapeHtml(status.error)}</p>` : ""}
    </article>`;
}

function renderDsWorkflowDetails(country) {
  const stuck = country.stuckWorkflows || [];
  const stale = country.staleWorkflows || [];
  const failed = country.failedWorkflows || [];
  const issueCount = stuck.length + stale.length + failed.length;
  if (issueCount === 0) return "";
  let body = "";
  if (stuck.length) {
    body += '<div class="ds-detail-group"><div class="ds-detail-title" style="color:#991b1b;">⤵️ 卡死（' + stuck.length + '）</div>';
    for (const wf of stuck) {
      const detail = wf.consecutiveFailures ? '连续失败 ' + wf.consecutiveFailures + ' 次' : '运行超时';
      body += '<div class="ds-detail-item">• ' + escapeHtml(wf.workflowName || wf.workflowCode) + ' <span class="muted">(' + detail + ')</span></div>';
    }
    body += "</div>";
  }
  if (stale.length) {
    body += '<div class="ds-detail-group"><div class="ds-detail-title" style="color:#92400e;">⚠️ 无运行记录（在线未运行，' + stale.length + ' 个）</div><div class="ds-detail-scroll">';
    for (const wf of stale) {
      const reason = wf.staleReason || wf.staleMessage || "定时任务已下线";
      body += '<div class="ds-detail-item">• ' + escapeHtml(wf.workflowName || wf.workflowCode) + ' <span class="muted">(' + escapeHtml(reason) + ')</span></div>';
    }
    body += "</div></div>";
  }
  if (failed.length) {
    body += '<div class="ds-detail-group"><div class="ds-detail-title" style="color:#b91c1c;">✖ 执行失败（' + failed.length + '）</div><div class="ds-detail-scroll">';
    for (const wf of failed) {
      const reason = wf.failureMessage || wf.failureReason || "当天定时实例执行失败";
      body += '<div class="ds-detail-item">• ' + escapeHtml(wf.workflowName || wf.workflowCode) + ' <span class="muted">(' + escapeHtml(reason) + ')</span></div>';
    }
    body += "</div></div>";
  }
  return '<details class="ds-detail-toggle"><summary>查看 ' + issueCount + ' 个异常工作流明细</summary><div class="ds-detail-body">' + body + "</div></details>";
}

function renderResult() {
  const result = model.result;
  if (!result) {
    return `<section class="panel ds-config-section"><h2 class="panel-title">测试结果</h2><p class="muted">尚未执行 DS 测试。测试只读取 DS 状态，不发送通知。</p></section>`;
  }
  return `
    <section class="panel ds-config-section">
      <div class="detail-header compact-header"><div><h2 class="panel-title">测试结果</h2><p class="muted">${formatTime(result.checkedAt)} · 本次未发送通知</p></div></div>
      <div class="card-list">
        ${(result.countries || []).map((country) => {
          const display = summarizeDsCountryCheck(country);
          return `
          <article class="card-row ds-result-card">
            <div>
              <h3>${escapeHtml(country.countryName || COUNTRY_LABELS[country.country] || country.country)}</h3>
              <p>${display.summary}</p>
              ${country.error ? `<p class="field-error">${escapeHtml(country.error)}</p>` : ""}
              ${renderDsWorkflowDetails(country)}
            </div>
            <span class="badge ${display.badgeClass}">${display.badgeText}</span>
          </article>`;
        }).join("")}
      </div>
    </section>`;
}

async function saveProjects(root) {
  if (model.saving) return;
  model.saving = true;
  setButtonBusy(root.querySelector("#ds-save-projects"), true, "保存中…");
  setButtonBusy(root.querySelector("#ds-run-test"), true, "测试中…");
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
      countries,
      projectNames,
    });
    model.config = await apiGet("/api/ds-scheduler/config");
    model.status = saved.resolveErrors?.length
      ? { type: "warn", text: `配置已保存，但部分项目名称匹配失败：${saved.resolveErrors.map((item) => `${item.country} ${item.error}`).join("；")}` }
      : { type: "success", text: "DS 项目配置已保存。" };
  } catch (error) {
    model.status = { type: "error", text: `项目配置保存失败：${error.message}` };
  } finally {
    model.saving = false;
  }
  paint(root);
  scrollStatusIntoView(root);
}

async function runTest(root) {
  if (model.saving) return;
  model.saving = true;
  setButtonBusy(root.querySelector("#ds-save-projects"), true, "保存中…");
  setButtonBusy(root.querySelector("#ds-run-test"), true, "测试中…");
  try {
    model.result = await apiPost("/api/ds-scheduler/check", {});
    model.status = { type: "success", text: `DS 测试完成：检查 ${model.result.totalChecked || 0} 个工作流，本次未发送通知。` };
  } catch (error) {
    model.status = { type: "error", text: `DS 测试失败：${error.message}` };
  } finally {
    model.saving = false;
  }
  paint(root);
  scrollStatusIntoView(root);
}

function renderHistory() {
  const runs = model.history?.runs || [];
  if (!runs.length) return "";
  const rows = runs.map((run) => {
    const time = formatTime(run.startedAt);
    const trigger = run.trigger === "schedule" ? "定时" : "手动";
    const ok = run.ok !== false;
    if (!ok) {
      return `<article class="card-row ds-history-row"><div><h3>${time}</h3><p class="field-error">${escapeHtml(run.error || "运行失败")}</p></div><span class="badge danger">失败</span></article>`;
    }
    const r = run.result || {};
    const stuck = r.totalStuck || 0;
    const stale = r.totalStale || 0;
    const executionFailed = r.totalFailed || 0;
    const checked = r.totalChecked || 0;
    const failed = r.failedCountries || 0;
    const hasIssue = stuck > 0 || stale > 0 || executionFailed > 0 || failed > 0;
    const badgeClass = hasIssue ? "warn" : "ok";
    const badgeText = hasIssue ? "有异常" : "正常";
    const countryBadges = (r.countries || []).map((c) => {
      const display = summarizeDsCountryCheck(c);
      const label = COUNTRY_LABELS[c.country] || c.country;
      const flag = COUNTRY_FLAGS[c.country] || "";
      const txt = c.success === false ? "检查失败" : (display.hasIssue ? `${display.stuck}卡/${display.stale}无/${display.failed}失败` : "正常");
      return `<span class="badge ${display.badgeClass}">${flag} ${label} ${txt}</span>`;
    }).join(" ");
    return `<article class="card-row ds-history-row"><div><h3>${time} · ${trigger}</h3><p>检查 ${checked} 个工作流 · 卡死 ${stuck} · 无运行记录 ${stale} · 执行失败 ${executionFailed} · 检查失败 ${failed}</p><div class="ds-history-countries">${countryBadges}</div></div><span class="badge ${badgeClass}">${badgeText}</span></article>`;
  }).join("");
  return `<section class="panel ds-config-section"><details class="ds-history-toggle"><summary>巡检记录（最近 ${runs.length} 次）</summary><div class="card-list">${rows}</div></details></section>`;
}

function renderStatus() {
  if (!model.status) return "";
  return `<div class="sandbox-status ${model.status.type}"><strong>${model.status.type === "success" ? "操作成功" : "提示"}</strong><span>${escapeHtml(model.status.text)}</span></div>`;
}

function resolvedCount() {
  return Object.values(model.config.projectStatus || {}).filter((item) => item.status === "resolved").length;
}

function stat(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString("zh-CN", { hour12: false });
}

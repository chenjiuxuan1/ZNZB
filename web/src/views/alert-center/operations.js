import { apiGet, apiPost } from "../../api.js";
import { escapeHtml } from "../../view-utils.js";

const SOURCE_LABELS = Object.freeze({
  nightingale: "Nightingale",
  n8n: "n8n",
});

export function filterScriptCapableEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) =>
    Boolean(String(entry?.templateName || "").trim() || String(entry?.scriptPath || "").trim()),
  );
}

export function canPublishEntry(selectedEntryId, previewedEntryId) {
  return Boolean(selectedEntryId) && selectedEntryId === previewedEntryId;
}

export function renderOperationsShell() {
  return `
    <div class="ac-ops-grid">
      <section class="sub-panel ac-ops-card" id="ac-operations-health">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">连接状态</h2>
            <p class="muted">实时检查 Nightingale 与 n8n；单一来源故障不会遮蔽其他来源。</p>
          </div>
        </div>
        <div id="ac-ops-health" aria-live="polite"><div class="notice">正在检查连接…</div></div>
      </section>

      <section class="sub-panel ac-ops-card" id="ac-operations-tests">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">测试与验证</h2>
            <p class="muted">按对象选择正确的测试工作台，避免混淆模拟检查与生产通知。</p>
          </div>
        </div>
        <div class="ac-ops-actions">
          <a class="ac-ops-action" href="#/sandbox">
            <strong>Metabase 规则沙盒</strong>
            <span>离线数据或只读实时查询，不发送通知。</span>
          </a>
          <a class="ac-ops-action" href="#/alert-registry?focus=dry-run">
            <strong>自定义告警 dry-run</strong>
            <span>执行条目测试命令，不发送群消息或电话。</span>
          </a>
        </div>
      </section>

      <section class="sub-panel ac-ops-card ac-ops-card-wide" id="ac-script-release">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">脚本与发布</h2>
            <p class="muted">先预览已保存配置生成的脚本，再明确确认提交与目标机部署。</p>
          </div>
        </div>
        <div id="ac-ops-release"><div class="notice">正在加载可发布条目…</div></div>
      </section>

      <section class="sub-panel ac-ops-card ac-ops-card-wide" id="ac-operations-audit">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">运维记录</h2>
            <p class="muted">发布审计与告警执行记录分开呈现，避免把测试记录误认为部署结果。</p>
          </div>
        </div>
        <div class="ac-ops-record-grid">
          <div><h3>脚本预览与发布审计</h3><div id="ac-ops-script-audit"><div class="notice">正在加载…</div></div></div>
          <div><h3>告警条目执行记录</h3><div id="ac-ops-execution-history"><div class="notice">正在加载…</div></div></div>
        </div>
      </section>
    </div>
  `;
}

function parseHealthStatus(value) {
  const raw = String(value || "not-configured");
  if (raw === "ok") return { tone: "success", label: "连接正常", detail: "接口访问与认证验证通过。" };
  if (raw === "not-configured") return { tone: "warn", label: "尚未配置", detail: "请检查服务地址和凭据配置。" };
  return {
    tone: "error",
    label: "连接异常",
    detail: raw.replace(/^error:\s*/i, "") || "上游接口不可用。",
  };
}

export function renderHealthSources(health = {}) {
  return `<div class="ac-source-health">
    ${Object.entries(SOURCE_LABELS).map(([key, label]) => {
      const status = parseHealthStatus(health?.[key]);
      return `<div class="ac-source-health__item is-${status.tone}">
        <span class="ac-source-health__dot" aria-hidden="true"></span>
        <div><strong>${label}</strong><span>${escapeHtml(status.label)}</span><small>${escapeHtml(status.detail)}</small></div>
      </div>`;
    }).join("")}
  </div>`;
}

function renderLoadError(title, error) {
  return `<div class="sandbox-status error"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(error?.message || String(error))}</span></div>`;
}

function renderReleaseWorkspace(entries) {
  if (!entries.length) {
    return `<div class="alert-lifecycle-empty"><strong>暂无可发布脚本</strong><p>告警条目需要配置模板名称或仓库脚本路径后才会出现在这里。</p></div>`;
  }
  return `
    <div class="ac-ops-release-controls">
      <label>告警条目
        <select id="ac-ops-entry">
          ${entries.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name || entry.id)} · ${escapeHtml(entry.country || "未分国家")}</option>`).join("")}
        </select>
      </label>
      <button type="button" id="ac-ops-preview">预览脚本</button>
      <button type="button" class="primary" id="ac-ops-publish" disabled>提交并部署</button>
    </div>
    <p class="muted small">发布按钮会在当前选中条目预览成功后启用；切换条目会立即失效。</p>
    <div id="ac-ops-release-result" aria-live="polite"></div>
  `;
}

function renderPreviewResult(result) {
  if (!result?.ok) {
    return `<div class="sandbox-status error"><strong>脚本预览失败</strong><span>${escapeHtml(result?.note || "脚本未完整生成")}</span></div>`;
  }
  const diff = result.diff || {};
  return `
    <div class="sandbox-status success"><strong>脚本预览完成</strong><span>${escapeHtml(String(diff.added ?? 0))} 行新增，${escapeHtml(String(diff.removed ?? 0))} 行删除。确认内容后才可发布。</span></div>
    <details open><summary>渲染后的脚本</summary><pre class="code ac-ops-script-preview">${escapeHtml(result.rendered || "")}</pre></details>
  `;
}

function renderPublishResult(result) {
  const git = result?.git;
  const deploy = result?.deploy;
  const failed = !result?.ok || (git && !git.ok) || (deploy && !deploy.ok);
  return `
    <div class="sandbox-status ${failed ? "error" : "success"}">
      <strong>${failed ? "发布未全部完成" : "发布完成"}</strong>
      <span>渲染：${result?.ok ? "完成" : "失败"} · Git：${git ? (git.ok ? "完成" : "失败") : "未配置"} · 部署：${deploy ? (deploy.ok ? "完成" : "失败") : "未配置"}</span>
    </div>
  `;
}

function formatOperationTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function renderScriptAudit(records) {
  if (!Array.isArray(records) || !records.length) return `<p class="muted">暂无脚本操作记录。</p>`;
  return `<div class="ac-ops-audit">${records.slice(0, 12).map((record) => `
    <div class="ac-ops-audit__row">
      <div><strong>${escapeHtml(record.entryName || record.entryId || "未知条目")}</strong><span>${record.action === "publish" ? "提交与部署" : "脚本预览"}</span></div>
      <span class="badge ${record.status === "success" ? "ok" : "warn"}">${record.status === "success" ? "成功" : record.status === "partial" ? "部分成功" : "失败"}</span>
      <time>${escapeHtml(formatOperationTime(record.startedAt))}</time>
      ${record.error ? `<small class="error">${escapeHtml(record.error)}</small>` : ""}
    </div>`).join("")}</div>`;
}

function renderExecutionHistory(records) {
  if (!Array.isArray(records) || !records.length) return `<p class="muted">暂无告警条目执行记录。</p>`;
  return `<div class="ac-ops-audit">${records.slice(0, 12).map((record) => `
    <div class="ac-ops-audit__row">
      <div><strong>${escapeHtml(record.entryName || record.entryId || "未知条目")}</strong><span>${escapeHtml(record.source || "entry")}</span></div>
      <span class="badge ${record.hasError || record.hasAlert ? "warn" : "ok"}">${record.hasError ? "执行失败" : record.hasAlert ? "发现异常" : "执行完成"}</span>
      <time>${escapeHtml(formatOperationTime(record.checkedAt))}</time>
    </div>`).join("")}</div>`;
}

async function reloadScriptAudit(container) {
  if (!container) return;
  try {
    container.innerHTML = renderScriptAudit(await apiGet("/api/alert-registry/script-audit"));
  } catch (error) {
    container.innerHTML = renderLoadError("发布审计加载失败", error);
  }
}

function bindReleaseActions(container, entries, auditContainer) {
  const select = container.querySelector("#ac-ops-entry");
  const previewButton = container.querySelector("#ac-ops-preview");
  const publishButton = container.querySelector("#ac-ops-publish");
  const output = container.querySelector("#ac-ops-release-result");
  const state = { previewedEntryId: "" };

  const refreshPublishGuard = () => {
    publishButton.disabled = !canPublishEntry(select.value, state.previewedEntryId);
  };
  select.addEventListener("change", () => {
    state.previewedEntryId = "";
    output.innerHTML = "";
    refreshPublishGuard();
  });
  previewButton.addEventListener("click", async () => {
    const id = select.value;
    state.previewedEntryId = "";
    refreshPublishGuard();
    previewButton.disabled = true;
    output.innerHTML = `<div class="notice">正在只读渲染脚本…</div>`;
    try {
      const result = await apiPost(`/api/alert-registry/${encodeURIComponent(id)}/preview-script`, {});
      output.innerHTML = renderPreviewResult(result);
      if (result?.ok) state.previewedEntryId = id;
      await reloadScriptAudit(auditContainer);
    } catch (error) {
      output.innerHTML = renderLoadError("脚本预览失败", error);
      await reloadScriptAudit(auditContainer);
    } finally {
      previewButton.disabled = false;
      refreshPublishGuard();
    }
  });
  publishButton.addEventListener("click", async () => {
    const id = select.value;
    if (!canPublishEntry(id, state.previewedEntryId)) return;
    const entry = entries.find((item) => item.id === id);
    const impact = [entry?.repoDir && entry?.scriptPath ? `仓库 ${entry.repoDir}/${entry.scriptPath}` : "未配置仓库文件", entry?.remoteScriptPath ? `目标机 ${entry.sshHost || "默认主机"}:${entry.remoteScriptPath}` : "未配置目标机部署"].join("\n");
    if (!confirm(`确认提交并部署「${entry?.name || id}」？\n${impact}\n\n此操作会修改生产代码或目标机文件。`)) return;
    publishButton.disabled = true;
    previewButton.disabled = true;
    output.innerHTML = `<div class="notice">正在提交并部署，请勿重复操作…</div>`;
    try {
      const result = await apiPost(`/api/alert-registry/${encodeURIComponent(id)}/apply-script`, {}, { timeoutMs: 120000 });
      output.innerHTML = renderPublishResult(result);
      state.previewedEntryId = "";
      await reloadScriptAudit(auditContainer);
    } catch (error) {
      output.innerHTML = renderLoadError("提交或部署失败", error);
      await reloadScriptAudit(auditContainer);
    } finally {
      previewButton.disabled = false;
      refreshPublishGuard();
    }
  });
}

export async function loadOperationsWorkspace(root, body, refreshTime) {
  body.innerHTML = renderOperationsShell();
  const healthContainer = body.querySelector("#ac-ops-health");
  const releaseContainer = body.querySelector("#ac-ops-release");
  const scriptAuditContainer = body.querySelector("#ac-ops-script-audit");
  const historyContainer = body.querySelector("#ac-ops-execution-history");

  const [healthResult, entriesResult, historyResult, auditResult] = await Promise.allSettled([
    apiGet("/api/alerts/health"),
    apiGet("/api/alert-registry"),
    apiGet("/api/alert-registry/history"),
    apiGet("/api/alert-registry/script-audit"),
  ]);

  healthContainer.innerHTML = healthResult.status === "fulfilled"
    ? renderHealthSources(healthResult.value)
    : renderLoadError("连接检查失败", healthResult.reason);

  if (entriesResult.status === "fulfilled") {
    const entries = filterScriptCapableEntries(entriesResult.value);
    releaseContainer.innerHTML = renderReleaseWorkspace(entries);
    if (entries.length) bindReleaseActions(releaseContainer, entries, scriptAuditContainer);
  } else {
    releaseContainer.innerHTML = renderLoadError("可发布条目加载失败", entriesResult.reason);
  }

  historyContainer.innerHTML = historyResult.status === "fulfilled"
    ? renderExecutionHistory(historyResult.value)
    : renderLoadError("执行记录加载失败", historyResult.reason);
  scriptAuditContainer.innerHTML = auditResult.status === "fulfilled"
    ? renderScriptAudit(auditResult.value)
    : renderLoadError("发布审计加载失败", auditResult.reason);

  if (refreshTime) refreshTime.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
}

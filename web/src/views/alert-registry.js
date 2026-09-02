import { apiDelete, apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

/**
 * 告警注册表：动态配置 / 新增 / 测试 n8n 与夜莺等告警条目。
 *
 * 能力：
 *   1. 列表展示所有告警条目（名称/国家/来源/触发/状态/命令）
 *   2. 新增 / 编辑 / 删除 / 启停
 *   3. 每条「▶ 测试」：平台直接执行（SSH dry-run 或本地命令），结果展示 stdout/stderr/exitCode
 *   4. 「测试命令」：新增前先用任意命令验证（动态添加测试代码入口）
 */
export function renderAlertRegistry(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">告警注册</h1>
        <p class="page-note">把 n8n / 夜莺等告警抽象为可配置条目，动态新增与测试。测试走 dry-run，不发送通知。</p>
      </div>
      <div class="header-actions">
        <button class="primary" id="ar-refresh">刷新</button>
        <button id="ar-new">+ 新增告警</button>
      </div>
    </div>
    <section class="panel">
      <div id="ar-list"></div>
    </section>
    <section class="panel" id="ar-test-panel" style="display:none">
      <div class="panel-title">测试结果</div>
      <div id="ar-test-output"></div>
    </section>
    <section class="panel">
      <div class="panel-title">多国一致性校验 · 最近 7 次结果</div>
      <div class="panel-note">由「多国一致性校验告警」n8n 工作流每次校验后回写；有异常（mismatch_cnt &gt; 0）的国家会标红。</div>
      <div id="mc-results"></div>
    </section>
  `;

  root.querySelector("#ar-refresh").addEventListener("click", () => {
    loadList(root);
    loadMcResults(root);
  });
  root.querySelector("#ar-new").addEventListener("click", () => openEditor(root, null));

  loadList(root);
  loadMcResults(root);
}

/** 加载最近 7 次多国一致性校验结果。 */
async function loadMcResults(root) {
  const el = root.querySelector("#mc-results");
  if (!el) return;
  let runs;
  try {
    runs = await apiGet("/api/multi-country/check-results");
  } catch (error) {
    el.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    return;
  }
  if (!Array.isArray(runs) || !runs.length) {
    el.innerHTML = `<div class="notice">暂无校验记录。运行「多国一致性校验告警」后会自动回写最近 7 次结果。</div>`;
    return;
  }
  el.innerHTML = runs.map((run, idx) => {
    const ts = formatTs(run.checkedAt);
    const summary = (run.countries || []).map((c) => {
      const m = c.mismatches || [];
      const has = m.length > 0;
      const cls = has ? "mc-badge mc-badge-red" : "mc-badge mc-badge-green";
      const detail = has
        ? ` (${m.map((x) => `${x.check_item}=${x.mismatch_cnt}`).join(", ")})`
        : "";
      return `<span class="${cls}">${escapeHtml(c.label || c.code || "")}${detail}</span>`;
    }).join(" ");
    const alertMark = run.hasAlert ? ` <span class="mc-badge mc-badge-red">异常</span>` : ` <span class="mc-badge mc-badge-green">正常</span>`;
    return `
      <div class="mc-run ${idx === 0 ? "mc-run-latest" : ""}">
        <div class="mc-run-head">
          <span class="mc-run-id">#${run.id ? String(run.id).slice(0, 8) : idx + 1}</span>
          <span class="mc-run-ts">${ts}</span>
          ${alertMark}
        </div>
        <div class="mc-run-countries">${summary || `<span class="mc-badge mc-badge-gray">无国家数据</span>`}</div>
      </div>
    `;
  }).join("");
}

function formatTs(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadList(root) {
  const listEl = root.querySelector("#ar-list");
  listEl.innerHTML = `<div class="notice">正在加载…</div>`;
  let alerts;
  try {
    alerts = await apiGet("/api/alert-registry");
  } catch (error) {
    listEl.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    return;
  }
  const items = Array.isArray(alerts) ? alerts : alerts?.alerts || [];
  if (!items.length) {
    listEl.innerHTML = `<div class="notice">暂无告警条目，点右上角「+ 新增告警」创建。</div>`;
    return;
  }
  listEl.innerHTML = `
    <div class="ar-table-wrap">
      <table class="ar-table">
        <thead>
          <tr>
            <th>名称 / ID</th>
            <th>国家</th>
            <th>来源</th>
            <th>触发</th>
            <th>状态</th>
            <th>执行命令</th>
            <th class="ar-ops-col">操作</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(renderRow).join("")}
        </tbody>
      </table>
    </div>
  `;
  listEl.querySelectorAll("[data-ar-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.arEdit;
      openEditor(root, items.find((item) => item.id === id) || null);
    });
  });
  listEl.querySelectorAll("[data-ar-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.arDelete;
      const item = items.find((item) => item.id === id);
      if (!confirm(`确认删除告警「${item.name}」？`)) return;
      try {
        await apiDelete(`/api/alert-registry/${encodeURIComponent(id)}`);
        loadList(root);
      } catch (error) {
        alert(`删除失败：${error.message}`);
      }
    });
  });
  listEl.querySelectorAll("[data-ar-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.arToggle;
      const item = items.find((item) => item.id === id);
      try {
        await apiPut(`/api/alert-registry/${encodeURIComponent(id)}`, { enabled: !item.enabled });
        loadList(root);
      } catch (error) {
        alert(`启停失败：${error.message}`);
      }
    });
  });
  listEl.querySelectorAll("[data-ar-test]").forEach((button) => {
    button.addEventListener("click", () => runTest(root, button.dataset.arTest));
  });
}

function renderRow(item) {
  const cmd = item.command || "";
  const srcLabel = {
    n8n: "n8n",
    nightingale: "夜莺",
    custom: "自定义",
  }[item.sourceType] || item.sourceType || "custom";
  const triggerLabel = {
    webhook: "Webhook",
    schedule: "定时",
    manual: "手动",
  }[item.trigger] || item.trigger || "手动";
  const srcClass = item.sourceType === "nightingale" ? "ar-badge-purple" : item.sourceType === "custom" ? "ar-badge-gray" : "ar-badge-blue";
  return `
    <tr>
      <td class="ar-name-cell">
        <div class="ar-name" title="${escapeHtml(item.note || "")}">${escapeHtml(item.name)}</div>
        <div class="ar-id" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</div>
      </td>
      <td><span class="ar-country">${escapeHtml(item.country || "-")}</span></td>
      <td><span class="badge ${srcClass}">${escapeHtml(srcLabel)}</span></td>
      <td><span class="ar-trigger">${escapeHtml(triggerLabel)}</span></td>
      <td><span class="badge ${item.enabled ? "ok" : ""} ar-status">${item.enabled ? "启用" : "停用"}</span></td>
      <td class="ar-cmd-cell">
        <code class="ar-cmd" title="${escapeHtml(cmd)}">${escapeHtml(cmd || "-")}</code>
      </td>
      <td class="ar-ops-col">
        <div class="ar-ops">
          <button class="ar-btn ar-btn-test" data-ar-test="${escapeHtml(item.id)}">▶ 测试</button>
          <button class="ar-btn" data-ar-edit="${escapeHtml(item.id)}">编辑</button>
          <button class="ar-btn" data-ar-toggle="${escapeHtml(item.id)}">${item.enabled ? "停用" : "启用"}</button>
          <button class="ar-btn ar-btn-danger" data-ar-delete="${escapeHtml(item.id)}">删除</button>
        </div>
      </td>
    </tr>
  `;
}

async function runTest(root, id) {
  const panel = root.querySelector("#ar-test-panel");
  const output = root.querySelector("#ar-test-output");
  panel.style.display = "";
  output.innerHTML = `<div class="notice">正在执行测试（SSH dry-run / 本地命令），最长 90 秒…</div>`;
  try {
    const result = await apiPost(`/api/alert-registry/${encodeURIComponent(id)}/test`, {}, { timeoutMs: 100000 });
    renderTestResult(output, result);
  } catch (error) {
    output.innerHTML = `<div class="sandbox-status error"><strong>测试失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
  }
}

function renderTestResult(output, result) {
  const ok = result.ok;
  const color = ok ? "success" : "error";
  output.innerHTML = `
    <div class="sandbox-status ${color}">
      <strong>${ok ? "测试通过" : "测试失败"} · 退出码 ${result.exitCode == null ? "-" : escapeHtml(String(result.exitCode))}</strong>
      <span>${escapeHtml(result.name || "")}</span>
    </div>
    ${renderOutputBlock("stdout", result.stdout)}
    ${result.stderr ? renderOutputBlock("stderr", result.stderr) : ""}
  `;
}

function renderOutputBlock(label, text) {
  if (!text) return "";
  return `
    <div class="panel-title">${escapeHtml(label)}</div>
    <pre class="code">${escapeHtml(text)}</pre>
  `;
}

// SQL 块 → 中文标签（模板占位符键名保持英文，标签用中文）
const SQL_BLOCK_LABELS = {
  BIZ_CTE_CLAUSE: "非经营 CTE 公共表（biz库）",
  FIN_UNION_SELECT: "财务对账查询（capital 三表）",
  BIZ_UNION_SELECT: "biz 对账查询（五国非经营）",
  BIZ_QUERY_SQL: "biz 对账查询（含 CTE，五国非经营）",
  MONITOR_TABLE: "监控表（被校验表）",
  LTV_QUERY_SQL: "LTV 查询语句",
  CHECK_TABLE: "校验记录表",
  EXPECTED_TABLES: "期望表清单（印尼）",
  MX_EXPECTED_TABLES: "期望表清单（墨西哥）",
};

function sqlBlockLabel(key) {
  return SQL_BLOCK_LABELS[key] || key;
}

function renderSqlEditorSection(data) {
  const blocks = (data.sqlBlocks && typeof data.sqlBlocks === "object") ? data.sqlBlocks : {};
  const blockNames = Object.keys(blocks).length
    ? Object.keys(blocks)
    : ["FIN_UNION_SELECT", "BIZ_CTE_CLAUSE", "BIZ_UNION_SELECT"];
  const blockHtml = blockNames.map((key) => {
    const value = blocks[key] || "";
    const lines = value ? value.split("\n").length : 0;
    return `
    <div class="ar-field-full">
      <div class="ar-sql-title">
        <span class="strong">${escapeHtml(sqlBlockLabel(key))}</span>
        <span class="muted">（${escapeHtml(key)}）</span>
        <span class="ar-sql-lines">${lines ? lines + " 行" : "空"}</span>
      </div>
      <textarea class="ar-field ar-sql-block" data-sql-block="${escapeHtml(key)}" data-auto-resize rows="4" placeholder="（在此填写 ${escapeHtml(sqlBlockLabel(key))} 的 SQL）">${escapeHtml(value)}</textarea>
    </div>
  `;
  }).join("");
  return `
    <div class="ar-section">
      <div class="ar-section-head">
        <span class="ar-sec-icon">🧩</span>
        <span>校验语句（SQL 块）</span>
        <span class="ar-sec-tip">保存后可「更新代码」合成脚本并部署/提交</span>
      </div>
      <div class="ar-section-body">
        <div class="ar-field-grid">
          <label class="ar-label">模板名
            <input class="ar-field" id="ar-f-template" value="${escapeHtml(data.templateName || "")}" placeholder="如 fin_ods_quality / mx_capital_ltv / id_marketing_dwd_cnt">
          </label>
          <label class="ar-label">仓库内脚本路径
            <input class="ar-field" id="ar-f-scriptPath" value="${escapeHtml(data.scriptPath || "")}" placeholder="如 alert/fin_manage_ods_data_quality_monitor_alert.py">
          </label>
          <label class="ar-label">目标机脚本路径
            <input class="ar-field" id="ar-f-remotePath" value="${escapeHtml(data.remoteScriptPath || "")}" placeholder="如 /root/starrocks-pl-monitor-tv-alert/alert/xxx.py">
          </label>
          <label class="ar-label">本地 Git 仓库目录
            <input class="ar-field" id="ar-f-repoDir" value="${escapeHtml(data.repoDir || "")}" placeholder="如 /path/to/starrocks-pl-monitor-tv-alert 或 \${ALERT_REPO_DIR}">
          </label>
          ${blockHtml}
        </div>
        <div class="ar-note-line" style="margin-top:12px">SQL 块内容会注入模板对应占位符；「预览脚本」可先看合成结果，确认无误后点「更新代码」写入仓库、git 提交推送并 SSH 部署到目标机。</div>
      </div>
    </div>
  `;
}

function openEditor(root, item) {
  const isEdit = Boolean(item);
  const data = item || {};
  const fields = [
    ["id", "ID（留空自动生成）", data.id || "", "ar-f-id"],
    ["name", "名称 *", data.name || "", "ar-f-name"],
    ["country", "国家", data.country || "", "ar-f-country"],
    ["sourceType", "来源类型", data.sourceType || "n8n", "ar-f-sourceType"],
    ["n8nWorkflowId", "n8n 工作流 ID", data.n8nWorkflowId || "", "ar-f-workflow"],
    ["trigger", "触发方式", data.trigger || "manual", "ar-f-trigger"],
    ["webhookPath", "Webhook 路径", data.webhookPath || "", "ar-f-webhook"],
    ["command", "执行命令 *（测试代码 / dry-run）", data.command || "", "ar-f-command"],
    ["runVia", "执行方式", data.runVia || "ssh", "ar-f-runVia"],
    ["sshHost", "SSH 主机", data.sshHost || "root@10.20.47.14", "ar-f-host"],
    ["sshPort", "SSH 端口", data.sshPort != null ? String(data.sshPort) : "36000", "ar-f-port"],
    ["mentions", "@ 成员（逗号分隔）", data.mentions || "", "ar-f-mentions"],
    ["enabled", "启用", data.enabled !== false, "ar-f-enabled"],
    ["note", "备注", data.note || "", "ar-f-note"],
  ];
  const sourceOptions = ["n8n", "nightingale", "custom"].map((v) =>
    `<option value="${v}" ${data.sourceType === v || (!data.sourceType && v === "n8n") ? "selected" : ""}>${v}</option>`
  ).join("");
  const triggerOptions = ["webhook", "schedule", "manual"].map((v) =>
    `<option value="${v}" ${data.trigger === v || (!data.trigger && v === "manual") ? "selected" : ""}>${v}</option>`
  ).join("");
  const runViaOptions = ["ssh", "local"].map((v) =>
    `<option value="${v}" ${data.runVia === v || (!data.runVia && v === "ssh") ? "selected" : ""}>${v}</option>`
  ).join("");

  const overlay = document.createElement("div");
  overlay.className = "ar-modal-overlay";
  overlay.innerHTML = `
    <div class="ar-modal">
      <div class="ar-modal-header">
        <div>
          <h2 class="page-title">${isEdit ? "编辑告警" : "新增告警"}</h2>
          <p class="page-note">配置条目信息；「测试命令」可先验证任意命令（新增前的测试代码），通过后再保存。</p>
        </div>
        <button id="ar-modal-close" class="ar-modal-close" title="关闭">×</button>
      </div>
      <div class="ar-modal-body">

        <div class="ar-section">
          <div class="ar-section-head">
            <span class="ar-sec-icon">📋</span>
            <span>基本信息</span>
          </div>
          <div class="ar-section-body">
            <div class="ar-field-grid">
              <label class="ar-label">ID
                <input class="ar-field" id="ar-f-id" value="${escapeHtml(fields[0][2])}" ${isEdit ? "readonly" : ""} placeholder="留空自动生成">
              </label>
              <label class="ar-label">名称 <span class="ar-req">*</span>
                <input class="ar-field" id="ar-f-name" value="${escapeHtml(fields[1][2])}">
              </label>
              <label class="ar-label">国家
                <input class="ar-field" id="ar-f-country" value="${escapeHtml(fields[2][2])}" placeholder="CN / MX / ID / PH…">
              </label>
              <label class="ar-label">来源类型
                <select class="ar-field" id="ar-f-sourceType">${sourceOptions}</select>
              </label>
              <label class="ar-label">n8n 工作流 ID
                <input class="ar-field" id="ar-f-workflow" value="${escapeHtml(fields[4][2])}">
              </label>
              <label class="ar-label">触发方式
                <select class="ar-field" id="ar-f-trigger">${triggerOptions}</select>
              </label>
              <label class="ar-label">Webhook 路径
                <input class="ar-field" id="ar-f-webhook" value="${escapeHtml(fields[6][2])}">
              </label>
              <label class="ar-label ar-field-wrap-check"><input type="checkbox" id="ar-f-enabled" ${fields[12][2] ? "checked" : ""}> 启用 <span class="ar-hint">是否参与触发</span></label>
            </div>
          </div>
        </div>

        <div class="ar-section">
          <div class="ar-section-head">
            <span class="ar-sec-icon">🚀</span>
            <span>执行与测试</span>
            <span class="ar-sec-tip">测试代码 / dry-run，支持 \${ENV} 占位</span>
          </div>
          <div class="ar-section-body">
            <div class="ar-field-grid">
              <label class="ar-label">执行方式
                <select class="ar-field" id="ar-f-runVia">${runViaOptions}</select>
              </label>
              <label class="ar-label">SSH 端口
                <input class="ar-field" id="ar-f-port" value="${escapeHtml(fields[10][2])}">
              </label>
              <label class="ar-label ar-field-full">SSH 主机
                <input class="ar-field" id="ar-f-host" value="${escapeHtml(fields[9][2])}" placeholder="如 root@10.20.47.14">
              </label>
              <label class="ar-label ar-field-full">@ 成员（逗号分隔）
                <input class="ar-field" id="ar-f-mentions" value="${escapeHtml(fields[11][2])}">
              </label>
              <label class="ar-label ar-field-full">执行命令 <span class="ar-req">*</span>
                <textarea class="ar-field ar-cmd-area" id="ar-f-command" data-auto-resize rows="4">${escapeHtml(fields[7][2])}</textarea>
              </label>
              <label class="ar-label ar-field-full">备注
                <input class="ar-field" id="ar-f-note" value="${escapeHtml(fields[13][2])}">
              </label>
            </div>
          </div>
        </div>

        ${renderSqlEditorSection(data)}
      </div>
      <div class="ar-modal-footer">
        <span class="ar-modal-progress muted small"></span>
        <button class="ar-btn ar-btn-test" id="ar-test-command">▶ 先测试命令</button>
        ${isEdit ? `<button class="ar-btn ar-btn-code" id="ar-preview-script">👁 预览脚本</button>
        <button class="ar-btn ar-btn-code" id="ar-apply-script">⚡ 更新代码（部署+提交）</button>` : ""}
        <button class="ar-btn ar-btn-primary" id="ar-save">${isEdit ? "保存" : "新增"}</button>
      </div>
      <div id="ar-command-output" style="padding:0 24px"></div>
      <div id="ar-script-output" style="padding:0 24px 12px"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // SQL 块 / 命令文本域自动适配高度（内容多则增高，最多 14 行后内部滚动）
  const autoResize = (el) => {
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 19;
    const minRows = 3;
    const maxRows = 14;
    el.style.height = "auto";
    const contentLines = Math.ceil(el.scrollHeight / lineHeight);
    const rows = Math.max(minRows, Math.min(maxRows, contentLines));
    el.style.height = `${Math.ceil(rows * lineHeight)}px`;
  };
  overlay.querySelectorAll("[data-auto-resize]").forEach((el) => {
    autoResize(el);
    el.addEventListener("input", () => autoResize(el));
  });

  const close = () => overlay.remove();
  overlay.querySelector("#ar-modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  overlay.querySelector("#ar-test-command").addEventListener("click", async () => {
    const cmd = overlay.querySelector("#ar-f-command").value;
    if (!cmd) {
      overlay.querySelector("#ar-command-output").innerHTML = `<div class="sandbox-status error"><strong>请先填写命令</strong></div>`;
      return;
    }
    const output = overlay.querySelector("#ar-command-output");
    output.innerHTML = `<div class="notice">正在执行命令，最长 90 秒…</div>`;
    try {
      const result = await apiPost("/api/alert-registry/test-command", {
        runVia: overlay.querySelector("#ar-f-runVia").value,
        command: cmd,
        sshHost: overlay.querySelector("#ar-f-host").value,
        sshPort: Number(overlay.querySelector("#ar-f-port").value || 36000),
      }, { timeoutMs: 100000 });
      output.innerHTML = renderCommandResult(result);
    } catch (error) {
      output.innerHTML = `<div class="sandbox-status error"><strong>命令执行失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    }
  });

  const previewBtn = overlay.querySelector("#ar-preview-script");
  if (previewBtn) {
    previewBtn.addEventListener("click", async () => {
      const output = overlay.querySelector("#ar-script-output");
      const entry = { ...collectEditorEntry(overlay, item) };
      output.innerHTML = `<div class="notice">正在渲染脚本…</div>`;
      try {
        // 预览需要先把当前编辑内容存到条目（PUT），再调 preview-script
        await apiPut(`/api/alert-registry/${encodeURIComponent(item.id)}`, entry);
        const result = await apiPost(`/api/alert-registry/${encodeURIComponent(item.id)}/preview-script`, {});
        renderScriptPreview(output, result);
      } catch (error) {
        output.innerHTML = `<div class="sandbox-status error"><strong>预览失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
      }
    });
  }

  const applyBtn = overlay.querySelector("#ar-apply-script");
  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      const output = overlay.querySelector("#ar-script-output");
      const entry = collectEditorEntry(overlay, item);
      if (!confirm("确认更新代码？将：①渲染脚本 ②写入仓库文件 ③git commit+push ④SSH 部署到目标机。")) return;
      output.innerHTML = `<div class="notice">正在更新代码（写仓库 + 提交 + 部署）…</div>`;
      try {
        await apiPut(`/api/alert-registry/${encodeURIComponent(item.id)}`, entry);
        const result = await apiPost(`/api/alert-registry/${encodeURIComponent(item.id)}/apply-script`, {});
        renderScriptApply(output, result);
      } catch (error) {
        output.innerHTML = `<div class="sandbox-status error"><strong>更新失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
      }
    });
  }

  overlay.querySelector("#ar-save").addEventListener("click", async () => {
    const name = overlay.querySelector("#ar-f-name").value.trim();
    const command = overlay.querySelector("#ar-f-command").value.trim();
    if (!name || !command) {
      alert("名称与执行命令为必填项");
      return;
    }
    const body = {
      id: overlay.querySelector("#ar-f-id").value.trim() || undefined,
      name,
      country: overlay.querySelector("#ar-f-country").value.trim(),
      sourceType: overlay.querySelector("#ar-f-sourceType").value,
      n8nWorkflowId: overlay.querySelector("#ar-f-workflow").value.trim(),
      trigger: overlay.querySelector("#ar-f-trigger").value,
      webhookPath: overlay.querySelector("#ar-f-webhook").value.trim(),
      command,
      runVia: overlay.querySelector("#ar-f-runVia").value,
      sshHost: overlay.querySelector("#ar-f-host").value.trim(),
      sshPort: Number(overlay.querySelector("#ar-f-port").value || 36000),
      mentions: overlay.querySelector("#ar-f-mentions").value.trim(),
      enabled: overlay.querySelector("#ar-f-enabled").checked,
      note: overlay.querySelector("#ar-f-note").value.trim(),
      templateName: overlay.querySelector("#ar-f-template")?.value.trim() || "",
      scriptPath: overlay.querySelector("#ar-f-scriptPath")?.value.trim() || "",
      remoteScriptPath: overlay.querySelector("#ar-f-remotePath")?.value.trim() || "",
      repoDir: overlay.querySelector("#ar-f-repoDir")?.value.trim() || "",
      sqlBlocks: collectSqlBlocks(overlay),
    };
    try {
      if (isEdit) {
        await apiPut(`/api/alert-registry/${encodeURIComponent(item.id)}`, body);
      } else {
        await apiPost("/api/alert-registry", body);
      }
      close();
      loadList(root);
    } catch (error) {
      alert(`保存失败：${error.message}`);
    }
  });
}

function renderCommandResult(result) {
  const ok = result.ok;
  const color = ok ? "success" : "error";
  return `
    <div class="sandbox-status ${color}">
      <strong>${ok ? "命令通过" : "命令失败"} · 退出码 ${result.exitCode == null ? "-" : escapeHtml(String(result.exitCode))}</strong>
    </div>
    ${result.stdout ? `<pre class="code">${escapeHtml(result.stdout)}</pre>` : ""}
    ${result.stderr ? `<pre class="code">${escapeHtml(result.stderr)}</pre>` : ""}
  `;
}

function collectSqlBlocks(overlay) {
  const blocks = {};
  overlay.querySelectorAll(".ar-sql-block").forEach((textarea) => {
    const key = textarea.dataset.sqlBlock;
    const value = textarea.value;
    if (key && value.trim()) blocks[key] = value;
  });
  return blocks;
}

function collectEditorEntry(overlay, item) {
  return {
    id: overlay.querySelector("#ar-f-id").value.trim() || undefined,
    name: overlay.querySelector("#ar-f-name").value.trim(),
    country: overlay.querySelector("#ar-f-country").value.trim(),
    sourceType: overlay.querySelector("#ar-f-sourceType").value,
    n8nWorkflowId: overlay.querySelector("#ar-f-workflow").value.trim(),
    trigger: overlay.querySelector("#ar-f-trigger").value,
    webhookPath: overlay.querySelector("#ar-f-webhook").value.trim(),
    command: overlay.querySelector("#ar-f-command").value.trim(),
    runVia: overlay.querySelector("#ar-f-runVia").value,
    sshHost: overlay.querySelector("#ar-f-host").value.trim(),
    sshPort: Number(overlay.querySelector("#ar-f-port").value || 36000),
    mentions: overlay.querySelector("#ar-f-mentions").value.trim(),
    enabled: overlay.querySelector("#ar-f-enabled").checked,
    note: overlay.querySelector("#ar-f-note").value.trim(),
    templateName: overlay.querySelector("#ar-f-template")?.value.trim() || "",
    scriptPath: overlay.querySelector("#ar-f-scriptPath")?.value.trim() || "",
    remoteScriptPath: overlay.querySelector("#ar-f-remotePath")?.value.trim() || "",
    repoDir: overlay.querySelector("#ar-f-repoDir")?.value.trim() || "",
    sqlBlocks: collectSqlBlocks(overlay),
  };
}

function renderScriptPreview(output, result) {
  if (!result.ok) {
    output.innerHTML = `
      <div class="sandbox-status error"><strong>脚本渲染不完整</strong><span>${escapeHtml(result.note || "")}${result.missing ? "：" + escapeHtml(result.missing.join(", ")) : ""}</span></div>
    `;
    return;
  }
  const diff = result.diff || {};
  output.innerHTML = `
    <div class="sandbox-status success">
      <strong>脚本渲染成功</strong>
      <span>${escapeHtml(result.note || "")} · 变更 ${diff.added ?? "-"} 增 / ${diff.removed ?? "-"} 删（${diff.newLines ?? result.length} 行）</span>
    </div>
    <details>
      <summary>查看渲染后的完整脚本（${escapeHtml(String(result.length || 0))} 字符）</summary>
      <pre class="code">${escapeHtml(result.rendered || "")}</pre>
    </details>
  `;
}

function renderScriptApply(output, result) {
  const git = result.git || {};
  const deploy = result.deploy || {};
  const parts = [];
  if (result.repoFile) parts.push(`仓库文件：<code>${escapeHtml(result.repoFile)}</code>`);
  if (result.git) parts.push(`Git：<span class="${git.ok ? "" : "muted"}">${git.ok ? "提交并推送成功" : "推送失败"}</span> ${git.stderr ? `<pre class="code">${escapeHtml(git.stderr)}</pre>` : ""}`);
  if (result.deploy) parts.push(`目标机部署：<span class="${deploy.ok ? "" : "muted"}">${deploy.ok ? "成功" : "失败"}</span> ${deploy.stderr ? `<pre class="code">${escapeHtml(deploy.stderr)}</pre>` : ""}`);
  if (!result.repoFile && !result.git && !result.deploy) {
    parts.push("未配置 repoDir/scriptPath 或 remoteScriptPath，仅完成渲染。");
  }
  output.innerHTML = `
    <div class="sandbox-status ${result.ok ? "success" : "error"}">
      <strong>${result.ok ? "更新代码完成" : "更新失败"}</strong><span>${escapeHtml(String(result.length || ""))} 字符</span>
    </div>
    <div class="muted">${parts.join("<br>")}</div>
  `;
}

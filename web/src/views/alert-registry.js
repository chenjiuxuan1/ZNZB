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
  `;

  root.querySelector("#ar-refresh").addEventListener("click", () => loadList(root));
  root.querySelector("#ar-new").addEventListener("click", () => openEditor(root, null));

  loadList(root);
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
    <table class="table">
      <thead>
        <tr>
          <th>名称</th>
          <th>国家</th>
          <th>来源</th>
          <th>触发</th>
          <th>状态</th>
          <th>命令</th>
          <th style="width:240px">操作</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(renderRow).join("")}
      </tbody>
    </table>
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
  const short = cmd.length > 70 ? `${cmd.slice(0, 70)}…` : cmd;
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
  return `
    <tr>
      <td title="${escapeHtml(item.note || "")}">
        <div class="strong">${escapeHtml(item.name)}</div>
        <div class="muted small">${escapeHtml(item.id)}</div>
      </td>
      <td>${escapeHtml(item.country || "-")}</td>
      <td><span class="badge">${escapeHtml(srcLabel)}</span></td>
      <td>${escapeHtml(triggerLabel)}</td>
      <td><span class="badge ${item.enabled ? "ok" : "muted"}">${item.enabled ? "启用" : "停用"}</span></td>
      <td><code class="small" title="${escapeHtml(cmd)}">${escapeHtml(short || "-")}</code></td>
      <td>
        <button class="primary small" data-ar-test="${escapeHtml(item.id)}">▶ 测试</button>
        <button class="small" data-ar-edit="${escapeHtml(item.id)}">编辑</button>
        <button class="small" data-ar-toggle="${escapeHtml(item.id)}">${item.enabled ? "停用" : "启用"}</button>
        <button class="danger small" data-ar-delete="${escapeHtml(item.id)}">删除</button>
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
  const blockHtml = blockNames.map((key) => `
    <label class="ar-label" style="grid-column:1 / span 2">
      <span class="strong">${escapeHtml(sqlBlockLabel(key))}</span>
      <span class="muted small">（${escapeHtml(key)}）</span>
      <textarea class="ar-field ar-sql-block" data-sql-block="${escapeHtml(key)}" rows="6" style="font-family:monospace;font-size:12px">${escapeHtml(blocks[key] || "")}</textarea>
    </label>
  `).join("");
  return `
    <div class="ar-sql-section" style="grid-column:1 / span 2;border-top:1px solid var(--border,#e5e7eb);padding-top:12px;margin-top:4px">
      <div class="panel-title">校验语句（SQL 块）— 保存后可「更新代码」合成脚本并部署/提交</div>
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label class="ar-label" style="grid-column:1">模板名
          <input class="ar-field" id="ar-f-template" value="${escapeHtml(data.templateName || "")}" placeholder="如 fin_ods_quality / mx_capital_ltv / id_marketing_dwd_cnt">
        </label>
        <label class="ar-label" style="grid-column:2">仓库内脚本路径
          <input class="ar-field" id="ar-f-scriptPath" value="${escapeHtml(data.scriptPath || "")}" placeholder="如 alert/fin_manage_ods_data_quality_monitor_alert.py">
        </label>
        <label class="ar-label" style="grid-column:1">目标机脚本路径
          <input class="ar-field" id="ar-f-remotePath" value="${escapeHtml(data.remoteScriptPath || "")}" placeholder="如 /root/starrocks-pl-monitor-tv-alert/alert/xxx.py">
        </label>
        <label class="ar-label" style="grid-column:2">本地 Git 仓库目录
          <input class="ar-field" id="ar-f-repoDir" value="${escapeHtml(data.repoDir || "")}" placeholder="如 /path/to/starrocks-pl-monitor-tv-alert 或 \${ALERT_REPO_DIR}">
        </label>
        ${blockHtml}
      </div>
      <div class="muted small" style="margin-top:6px">提示：SQL 块内容会注入模板对应占位符；「预览脚本」可先看合成结果，确认无误后点「更新代码」写入仓库、git 提交推送并 SSH 部署到目标机。</div>
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
  overlay.className = "modal-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 16px;";
  overlay.innerHTML = `
    <div class="modal" style="background:#fff;border-radius:12px;max-width:760px;width:100%;padding:24px;box-shadow:0 12px 40px rgba(0,0,0,.3);">
      <div class="page-header" style="margin-bottom:16px">
        <div>
          <h2 class="page-title">${isEdit ? "编辑告警" : "新增告警"}</h2>
          <p class="page-note">配置条目信息；「测试命令」可先验证任意命令（新增前的测试代码），通过后再保存。</p>
        </div>
        <button id="ar-modal-close" style="background:none;border:none;font-size:22px;cursor:pointer">×</button>
      </div>
      <div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label class="ar-label" style="grid-column:1">ID
          <input class="ar-field" id="ar-f-id" value="${escapeHtml(fields[0][2])}" ${isEdit ? "readonly" : ""}>
        </label>
        <label class="ar-label" style="grid-column:2">名称 *
          <input class="ar-field" id="ar-f-name" value="${escapeHtml(fields[1][2])}">
        </label>
        <label class="ar-label" style="grid-column:1">国家
          <input class="ar-field" id="ar-f-country" value="${escapeHtml(fields[2][2])}" placeholder="CN / MX / ID / PH…">
        </label>
        <label class="ar-label" style="grid-column:2">来源类型
          <select class="ar-field" id="ar-f-sourceType">${sourceOptions}</select>
        </label>
        <label class="ar-label" style="grid-column:1">n8n 工作流 ID
          <input class="ar-field" id="ar-f-workflow" value="${escapeHtml(fields[4][2])}">
        </label>
        <label class="ar-label" style="grid-column:2">触发方式
          <select class="ar-field" id="ar-f-trigger">${triggerOptions}</select>
        </label>
        <label class="ar-label" style="grid-column:1">Webhook 路径
          <input class="ar-field" id="ar-f-webhook" value="${escapeHtml(fields[6][2])}">
        </label>
        <label class="ar-label" style="grid-column:2">执行方式
          <select class="ar-field" id="ar-f-runVia">${runViaOptions}</select>
        </label>
        <label class="ar-label" style="grid-column:1 / span 1">SSH 主机
          <input class="ar-field" id="ar-f-host" value="${escapeHtml(fields[9][2])}">
        </label>
        <label class="ar-label" style="grid-column:2">SSH 端口
          <input class="ar-field" id="ar-f-port" value="${escapeHtml(fields[10][2])}">
        </label>
        <label class="ar-label" style="grid-column:1">@ 成员
          <input class="ar-field" id="ar-f-mentions" value="${escapeHtml(fields[11][2])}">
        </label>
        <label class="ar-label" style="grid-column:2" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="ar-f-enabled" ${fields[12][2] ? "checked" : ""}> 启用
        </label>
        <label class="ar-label" style="grid-column:1 / span 2">备注
          <input class="ar-field" id="ar-f-note" value="${escapeHtml(fields[13][2])}">
        </label>
        <label class="ar-label" style="grid-column:1 / span 2">执行命令 *（测试代码 / dry-run，支持 \${ENV} 占位）
          <textarea class="ar-field" id="ar-f-command" rows="4" style="font-family:monospace;font-size:12px">${escapeHtml(fields[7][2])}</textarea>
        </label>
        ${renderSqlEditorSection(data)}
      </div>
      <div style="margin-top:16px;display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap">
        <button id="ar-test-command">先测试命令</button>
        ${isEdit ? `<button id="ar-preview-script">预览脚本</button>
        <button class="primary" id="ar-apply-script">更新代码（部署+提交）</button>` : ""}
        <button class="primary" id="ar-save">${isEdit ? "保存" : "新增"}</button>
      </div>
      <div id="ar-command-output" style="margin-top:12px"></div>
      <div id="ar-script-output" style="margin-top:12px"></div>
    </div>
  `;
  document.body.appendChild(overlay);

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

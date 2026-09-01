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
      </div>
      <div style="margin-top:16px;display:flex;gap:12px;justify-content:flex-end">
        <button id="ar-test-command">先测试命令</button>
        <button class="primary" id="ar-save">${isEdit ? "保存" : "新增"}</button>
      </div>
      <div id="ar-command-output" style="margin-top:12px"></div>
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

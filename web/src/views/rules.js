import { apiPut } from "../api.js";
import { state, json } from "../state.js";

export function renderRules(root, { reload }) {
  const config = state.rulesConfig || { rules: [] };
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">规则配置</h1>
        <p class="page-note">编辑 <code>config/public-monitor.config.json</code>，保存前会做结构校验。</p>
      </div>
      <button class="primary" id="save-rules">保存规则</button>
    </div>
    <div class="split">
      <section class="panel">
        <h2 class="panel-title">规则列表</h2>
        <table>
          <thead><tr><th>#</th><th>类型</th><th>Dashboard</th><th>Card</th></tr></thead>
          <tbody>
            ${(config.rules || []).map((rule, index) => `
              <tr>
                <td>${index + 1}</td>
                <td><span class="badge">${rule.type || "-"}</span></td>
                <td>${rule.dashboardTitle || rule.dashboardTitles?.join(", ") || rule.dashboardTitlePattern || "-"}</td>
                <td>${rule.cardTitles?.join(", ") || rule.cardTitle || rule.cardTitlePattern || "-"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
      <section class="panel">
        <h2 class="panel-title">JSON 编辑</h2>
        <textarea id="rules-json">${escapeHtml(json(config))}</textarea>
        <p id="rules-status" class="muted"></p>
      </section>
    </div>
  `;
  root.querySelector("#save-rules").addEventListener("click", async () => {
    const status = root.querySelector("#rules-status");
    try {
      const next = JSON.parse(root.querySelector("#rules-json").value);
      await apiPut("/api/rules", next);
      status.className = "success";
      status.textContent = "保存成功。";
      await reload();
    } catch (error) {
      status.className = "error";
      status.textContent = error.payload?.errors?.join("\n") || error.message;
    }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

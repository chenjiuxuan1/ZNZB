import { apiPut } from "../api.js";
import { state, json } from "../state.js";

export function renderCountries(root, { reload }) {
  const config = state.countries || { countries: [] };
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">国家配置</h1>
        <p class="page-note">编辑 <code>config/countries.config.json</code>。第一版只保存本地 JSON。</p>
      </div>
      <button class="primary" id="save-countries">保存</button>
    </div>
    <section class="panel">
      <h2 class="panel-title">JSON 配置</h2>
      <textarea id="countries-json">${escapeHtml(json(config))}</textarea>
      <p id="countries-status" class="muted"></p>
    </section>
  `;
  root.querySelector("#save-countries").addEventListener("click", async () => {
    const status = root.querySelector("#countries-status");
    try {
      const next = JSON.parse(root.querySelector("#countries-json").value);
      await apiPut("/api/countries", next);
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

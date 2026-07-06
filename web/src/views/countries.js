import { apiPut } from "../api.js";
import { state } from "../state.js";
import { escapeHtml, json } from "../view-utils.js";

export function renderCountries(root, { reload }) {
  const config = state.countries || { countries: [] };
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">国家配置</h1>
        <p class="page-note">每个国家独立维护时区、Grafana 辅助看板和本地监控配置文件。保存后写入 <code>config/countries.config.json</code>。</p>
      </div>
      <button class="primary" id="save-countries">保存国家配置</button>
    </div>
    <div class="notice">
      <strong>说明</strong>
      <span>这里配置的是机器人巡检的国家入口。Metabase 报表清单仍直接来自 Metabase inventory，Grafana 链接只用于原生 Grafana 监控和数据质量看板。</span>
    </div>
    <section class="country-grid">
      ${(config.countries || []).map((country, index) => renderCountryCard(country, index)).join("")}
    </section>
    <details class="advanced">
      <summary>高级：查看完整 JSON</summary>
      <textarea id="countries-json">${escapeHtml(json(config))}</textarea>
    </details>
    <p id="countries-status" class="muted"></p>
  `;

  root.querySelector("#save-countries").addEventListener("click", async () => {
    const status = root.querySelector("#countries-status");
    try {
      const next = collectCountries(root, config);
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

function renderCountryCard(country, index) {
  return `
    <article class="entity-card" data-country-index="${index}">
      <div class="entity-card-header">
        <div>
          <h2>${escapeHtml(country.name || country.code || "未命名国家")}</h2>
          <p>${escapeHtml(country.code || "-")} · ${escapeHtml(country.timezone || "未配置时区")}</p>
        </div>
        <span class="badge ${country.status === "ready" ? "ok" : "warn"}">${escapeHtml(country.status || "unknown")}</span>
      </div>
      <div class="form-grid">
        ${field(index, "code", "国家代码", country.code, "ID / PH / TH")}
        ${field(index, "name", "国家名称", country.name, "印尼")}
        ${field(index, "timezone", "业务时区", country.timezone, "Asia/Jakarta")}
        ${field(index, "status", "状态", country.status, "ready")}
      </div>
      <div class="field wide-field">
        <label>Grafana 业务监控链接</label>
        <input data-field="grafanaDashboardUrl" value="${escapeHtml(country.grafanaDashboardUrl || "")}" placeholder="仅用于 Grafana 原生看板">
      </div>
      <div class="field wide-field">
        <label>Grafana 数据质量链接</label>
        <input data-field="dataQualityDashboardUrl" value="${escapeHtml(country.dataQualityDashboardUrl || "")}" placeholder="仅用于数据质量异常数读取">
      </div>
      <div class="field wide-field">
        <label>本地监控配置文件</label>
        <input data-field="monitorConfigFile" value="${escapeHtml(country.monitorConfigFile || "")}" placeholder="./config/monitor.xx.json">
      </div>
    </article>
  `;
}

function field(index, key, label, value, placeholder = "") {
  return `
    <div class="field">
      <label>${label}</label>
      <input data-country-index="${index}" data-field="${key}" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}">
    </div>
  `;
}

function collectCountries(root, original) {
  const countries = Array.from(root.querySelectorAll(".entity-card")).map((card, index) => {
    const previous = original.countries?.[index] || {};
    const next = { ...previous };
    for (const input of card.querySelectorAll("[data-field]")) {
      next[input.dataset.field] = input.value.trim();
    }
    return next;
  });
  return { ...original, countries };
}

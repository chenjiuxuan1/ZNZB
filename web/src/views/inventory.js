import { getDashboards, isDashboardExecutable, state } from "../state.js";
import { compactList, countryLabel, escapeHtml, json } from "../view-utils.js";

export function renderInventory(root) {
  const dashboards = getDashboards();
  const countries = state.countries?.countries || [];
  const configuredCountryCodes = countries.map((country) => country.code).filter(Boolean);
  const inventoryCountryCodes = dashboards.map((dashboard) => dashboard.countryCode || dashboard.country?.code).filter(Boolean);
  const countryCodes = [...new Set([...configuredCountryCodes, ...inventoryCountryCodes])];
  const selectedCountry = state.selected.countryCode || countryCodes[0] || "";
  const countryDashboards = dashboards.filter((dashboard) => (dashboard.countryCode || dashboard.country?.code) === selectedCountry);
  const selectedDashboard = countryDashboards.find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || countryDashboards[0] || null;
  const cards = selectedDashboard?.cards || [];

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">看板与卡片</h1>
        <p class="page-note">按国家查看 Metabase inventory。已标记来源表示业务要求巡检的看板范围；可执行卡片表示系统已经能通过接口读取并参与异常判断。</p>
      </div>
    </div>
    <div class="notice">
      <strong>怎么读</strong>
      <span>先选国家，再选看板；右侧会展示该看板下的卡片、字段、样例行和查询状态。用于确认“规则会检查哪些卡片”。</span>
    </div>
    <div class="country-tabs">
      ${countryCodes.map((code) => `
        <button class="${code === selectedCountry ? "active" : ""}" data-country-code="${escapeHtml(code)}">
          ${escapeHtml(countryLabel(code, countries))}
          <span>可执行 ${dashboards.filter((dashboard) => dashboard.countryCode === code && isDashboardExecutable(dashboard)).length}</span>
          <small>全部 ${dashboards.filter((dashboard) => dashboard.countryCode === code).length}</small>
        </button>
      `).join("")}
    </div>
    <div class="inventory-layout">
      <section class="panel">
        <h2 class="panel-title">${escapeHtml(countryLabel(selectedCountry, countries))} 的看板</h2>
        <div class="dashboard-list">
          ${countryDashboards.map((dashboard) => `
            <button class="dashboard-row ${dashboard === selectedDashboard ? "selected" : ""}" data-dashboard-uuid="${escapeHtml(dashboard.uuid || "")}">
              <span>
                <strong>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "-")}</strong>
                <small>${escapeHtml(dashboard.url || "无 URL")}</small>
              </span>
              ${isDashboardExecutable(dashboard)
                ? `<b class="badge ok">可执行 · ${dashboard.cards?.length || 0} 张卡片</b>`
                : `<b class="badge warn">待发现</b>`}
            </button>
          `).join("") || `<p class="muted">该国家暂无看板。</p>`}
        </div>
      </section>
      <section class="panel">
        ${selectedDashboard ? renderDashboardDetail(selectedDashboard, cards) : `<p class="muted">请选择一个看板。</p>`}
      </section>
    </div>
  `;

  root.querySelectorAll("[data-country-code]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.countryCode = button.dataset.countryCode;
      state.selected.dashboardUuid = "";
      renderInventory(root);
    });
  });
  root.querySelectorAll("[data-dashboard-uuid]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.dashboardUuid = button.dataset.dashboardUuid;
      renderInventory(root);
    });
  });
}

function renderDashboardDetail(dashboard, cards) {
  const executable = isDashboardExecutable(dashboard);
  return `
    <div class="detail-header">
      <div>
        <h2 class="panel-title">${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "-")}</h2>
        <p class="muted">${escapeHtml(dashboard.countryName || dashboard.countryCode || "-")} · ${executable ? `${cards.length} 张卡片` : "待发现卡片"}</p>
      </div>
      ${dashboard.url ? `<a class="link-button" href="${escapeHtml(dashboard.url)}" target="_blank" rel="noreferrer">打开 Metabase</a>` : ""}
    </div>
    ${executable ? `<div class="card-list">${cards.map((card) => renderCard(card)).join("")}</div>` : `
      <div class="source-notice">
        <span class="badge warn">已纳入巡检范围 · 待发现</span>
        <p>${escapeHtml(dashboard.pendingReason || "尚未取得 Metabase 卡片清单")}。完成内部 Metabase 发现后会自动变为可执行，无需再次录入看板。</p>
      </div>
    `}
    ${executable ? `<details class="advanced compact">
      <summary>高级：查看首张卡片 sampleRows</summary>
      <pre class="code">${escapeHtml(json(cards[0]?.sampleRows || []))}</pre>
    </details>` : ""}
  `;
}

function renderCard(card) {
  return `
    <article class="card-row">
      <div>
        <h3>${escapeHtml(card.title || "-")}</h3>
        <p>${escapeHtml(compactList(card.columns || [], 6))}</p>
      </div>
      <div class="card-meta">
        <span>cardId ${escapeHtml(card.cardId || "-")}</span>
        <span>dashcardId ${escapeHtml(card.dashcardId || "-")}</span>
        <span class="badge ${card.queryStatus === "ok" ? "ok" : "warn"}">${escapeHtml(card.queryStatus || "unknown")}</span>
      </div>
    </article>
  `;
}

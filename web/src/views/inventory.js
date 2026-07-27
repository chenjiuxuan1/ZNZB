import { state } from "../state.js";
import { compactList, countryLabel, escapeHtml, json } from "../view-utils.js";

export function renderInventory(root) {
  const dashboards = state.inventory?.dashboards || [];
  const panelSources = state.inventory?.panelSources || [];
  const countries = state.countries?.countries || [];
  const configuredCountryCodes = countries.map((country) => country.code).filter(Boolean);
  const inventoryCountryCodes = dashboards.map((dashboard) => dashboard.countryCode || dashboard.country?.code).filter(Boolean);
  const sourceCountryCodes = panelSources.map((source) => source.countryCode).filter(Boolean);
  const countryCodes = [...new Set([...configuredCountryCodes, ...inventoryCountryCodes, ...sourceCountryCodes])];
  const selectedCountry = state.selected.countryCode || countryCodes[0] || "";
  if (selectedCountry && state.selected.countryCode !== selectedCountry) {
    state.selected.countryCode = selectedCountry;
  }
  const countryDashboards = dashboards.filter((dashboard) => (dashboard.countryCode || dashboard.country?.code) === selectedCountry);
  const countryPanelSource = panelSources.find((source) => source.countryCode === selectedCountry);
  const sourcePanels = countryPanelSource?.panels || [];
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
    ${state.inventory?.loadError ? `<div class="sandbox-status error"><strong>看板清单加载失败</strong><span>${escapeHtml(state.inventory.loadError)}</span></div>` : ""}
    <div class="country-tabs">
      ${countryCodes.map((code) => `
        <button class="${code === selectedCountry ? "active" : ""}" data-country-code="${escapeHtml(code)}">
          ${escapeHtml(countryLabel(code, countries))}
          <span>可执行 ${dashboards.filter((dashboard) => dashboard.countryCode === code).length}</span>
          ${sourceCount(panelSources, code) ? `<small>已标记 ${sourceCount(panelSources, code)}</small>` : ""}
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
              <b>${dashboard.cards?.length || 0} 张卡片</b>
            </button>
          `).join("") || renderSourcePanelList(sourcePanels)}
        </div>
      </section>
      <section class="panel">
        ${selectedDashboard ? renderDashboardDetail(selectedDashboard, cards) : renderSourcePanelNotice(selectedCountry, countries, sourcePanels)}
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

function sourceCount(panelSources, countryCode) {
  return panelSources.find((source) => source.countryCode === countryCode)?.panels?.length || 0;
}

function renderSourcePanelList(sourcePanels) {
  if (!sourcePanels.length) {
    return `<p class="muted">该国家暂无已标记看板来源，也没有可执行巡检卡片。</p>`;
  }

  return `
    <div class="source-panel-intro">
      <strong>已标记为巡检范围</strong>
      <span>这些看板属于业务要求巡检的范围；当前还是 Metabase 内部链接，系统尚未拿到可查询卡片清单。</span>
    </div>
    ${sourcePanels.map((panel) => {
      const link = firstPanelLink(panel);
      return `
        <a class="dashboard-row source-dashboard-row" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">
          <span>
            <strong>${escapeHtml(panel.title || "-")}</strong>
            <small>${escapeHtml(sourceLinkType(link.url))} · ${escapeHtml(shortUrl(link.title || link.url || "无 URL"))}</small>
          </span>
          <b class="badge warn">待接入</b>
        </a>
      `;
    }).join("")}
  `;
}

function renderSourcePanelNotice(countryCode, countries, sourcePanels) {
  if (!sourcePanels.length) {
    return `<p class="muted">请选择一个看板。</p>`;
  }

  return `
    <div class="source-notice">
      <span class="badge warn">已标记，待接入</span>
      <h2 class="panel-title">${escapeHtml(countryLabel(countryCode, countries))} 已录入 ${sourcePanels.length} 个来源看板</h2>
      <p>这些链接已经被系统记录为该国家的巡检范围。但它们是 Metabase 内部 collection/dashboard 地址，不是 <code>/public/dashboard/&lt;uuid&gt;</code>，当前无登录态访问内部 API 会返回 401，所以还不能展开卡片和执行规则。</p>
      <p>处理方式：给平台配置 Metabase 登录态以读取内部 dashboard/collection，或在 Metabase 开启 public sharing 并重新发现。完成后这里会从“已标记来源”变成“可执行卡片”。</p>
    </div>
    <div class="card-list">
      ${sourcePanels.map((panel) => {
        const link = firstPanelLink(panel);
        return `
          <article class="card-row source-card-row">
            <div>
              <h3>${escapeHtml(panel.title || "-")}</h3>
              <p>${escapeHtml(sourceLinkType(link.url))} · 已标记为巡检范围，等待接入可查询卡片。</p>
            </div>
            ${link.url ? `<a class="link-button" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">打开来源</a>` : ""}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function firstPanelLink(panel) {
  const links = Array.isArray(panel?.links) ? panel.links : [];
  return links[0] || { title: "", url: "" };
}

function shortUrl(value) {
  const text = String(value || "");
  if (text.length <= 86) {
    return text;
  }
  return `${text.slice(0, 72)}...`;
}

function sourceLinkType(url) {
  const text = String(url || "");
  if (text.includes("/collection/")) {
    return "内部 collection";
  }
  if (text.includes("/dashboard/")) {
    return "内部 dashboard";
  }
  return "内部链接";
}

function renderDashboardDetail(dashboard, cards) {
  return `
    <div class="detail-header">
      <div>
        <h2 class="panel-title">${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "-")}</h2>
        <p class="muted">${escapeHtml(dashboard.countryName || dashboard.countryCode || "-")} · ${cards.length} 张卡片</p>
      </div>
      ${dashboard.url ? `<a class="link-button" href="${escapeHtml(dashboard.url)}" target="_blank" rel="noreferrer">打开 Metabase</a>` : ""}
    </div>
    <div class="card-list">
      ${cards.map((card) => renderCard(card)).join("") || `<p class="muted">暂无卡片。</p>`}
    </div>
    <details class="advanced compact">
      <summary>高级：查看首张卡片 sampleRows</summary>
      <pre class="code">${escapeHtml(json(cards[0]?.sampleRows || []))}</pre>
    </details>
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

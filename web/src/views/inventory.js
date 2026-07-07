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
  const countryDashboards = dashboards.filter((dashboard) => (dashboard.countryCode || dashboard.country?.code) === selectedCountry);
  const countryPanelSource = panelSources.find((source) => source.countryCode === selectedCountry);
  const sourcePanels = countryPanelSource?.panels || [];
  const selectedDashboard = countryDashboards.find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || countryDashboards[0] || null;
  const cards = selectedDashboard?.cards || [];

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">看板与卡片</h1>
        <p class="page-note">按国家查看 Metabase inventory。这里展示的是已发现的 Metabase 看板与卡片，不再通过 Grafana 目录页跳转发现。</p>
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
          <span>${dashboards.filter((dashboard) => dashboard.countryCode === code).length}</span>
          ${sourceCount(panelSources, code) ? `<small>来源 ${sourceCount(panelSources, code)}</small>` : ""}
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
    return `<p class="muted">该国家暂无公共看板清单。国家配置已存在，但还没有可巡检的 public dashboard UUID。</p>`;
  }

  return `
    <div class="source-panel-intro">
      <strong>已录入来源看板</strong>
      <span>这些是内部 Metabase 链接，当前不能直接巡检卡片。</span>
    </div>
    ${sourcePanels.map((panel) => {
      const link = firstPanelLink(panel);
      return `
        <a class="dashboard-row source-dashboard-row" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">
          <span>
            <strong>${escapeHtml(panel.title || "-")}</strong>
            <small>${escapeHtml(shortUrl(link.title || link.url || "无 URL"))}</small>
          </span>
          <b class="badge warn">待公共化</b>
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
      <span class="badge warn">暂不可巡检</span>
      <h2 class="panel-title">${escapeHtml(countryLabel(countryCode, countries))} 已录入 ${sourcePanels.length} 个来源看板</h2>
      <p>这些链接是 Metabase 内部 collection/dashboard 地址，不是 public dashboard UUID。当前巡检需要 public dashboard 接口读取卡片和查询结果，所以不会把这些来源链接直接纳入异常判断。</p>
      <p>处理方式：在 Metabase 将对应看板开启 public sharing，拿到 <code>/public/dashboard/&lt;uuid&gt;</code> 链接后再运行发现脚本，系统就能展示卡片并参与批量巡检。</p>
    </div>
    <div class="card-list">
      ${sourcePanels.map((panel) => {
        const link = firstPanelLink(panel);
        return `
          <article class="card-row source-card-row">
            <div>
              <h3>${escapeHtml(panel.title || "-")}</h3>
              <p>${escapeHtml(panel.textPreview || "内部链接，等待转成 public dashboard。")}</p>
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

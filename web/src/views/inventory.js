import { state, json } from "../state.js";

export function renderInventory(root) {
  const dashboards = state.inventory?.dashboards || [];
  const selected = dashboards[0] || null;
  const cards = selected?.cards || [];
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">看板与卡片</h1>
        <p class="page-note">直接浏览 Metabase inventory。本 MVP 不通过 Grafana 目录页跳转发现。</p>
      </div>
    </div>
    <div class="split">
      <section class="panel">
        <h2 class="panel-title">Dashboard</h2>
        <table>
          <thead><tr><th>国家</th><th>标题</th><th>卡片</th></tr></thead>
          <tbody>
            ${dashboards.map((dashboard, index) => `
              <tr class="${index === 0 ? "selected" : ""}">
                <td>${dashboard.countryName || dashboard.countryCode || "-"}</td>
                <td>${dashboard.title || dashboard.sourcePanelTitle || "-"}</td>
                <td>${dashboard.cards?.length || 0}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
      <section class="panel">
        <h2 class="panel-title">Card 明细</h2>
        ${cards.length ? `
          <table>
            <thead><tr><th>标题</th><th>cardId</th><th>dashcardId</th><th>列</th><th>状态</th></tr></thead>
            <tbody>
              ${cards.map((card) => `
                <tr>
                  <td>${card.title || "-"}</td>
                  <td>${card.cardId || "-"}</td>
                  <td>${card.dashcardId || "-"}</td>
                  <td>${(card.columns || []).slice(0, 5).join(", ")}</td>
                  <td><span class="badge ${card.queryStatus === "ok" ? "ok" : "warn"}">${card.queryStatus || "unknown"}</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          <h3 class="panel-title" style="margin-top:14px">首张卡片样例 rows</h3>
          <pre class="code">${escapeHtml(json(cards[0].sampleRows || []))}</pre>
        ` : `<p class="muted">暂无卡片。</p>`}
      </section>
    </div>
  `;
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

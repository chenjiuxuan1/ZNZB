import { state } from "../state.js";

export function renderDashboard(root) {
  const summary = state.summary || null;
  const data = summary || {};
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">巡检总览</h1>
        <p class="page-note">本页只读取本地配置和最近一次巡检结果，不访问线上 Metabase/Grafana。</p>
      </div>
    </div>
    <div class="grid cols-4">
      ${metric("国家", data.countryCount || 0)}
      ${metric("Dashboard", data.dashboardCount || 0)}
      ${metric("Card", data.cardCount || 0)}
      ${metric("规则", data.ruleCount || 0)}
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="panel">
        <h2 class="panel-title">最近结果</h2>
        ${data.lastResult ? `
          <table>
            <tr><th>巡检时间</th><td>${data.lastResult.checkedAt || "-"}</td></tr>
            <tr><th>检查卡片</th><td>${data.lastResult.checkedCardCount || 0}</td></tr>
            <tr><th>报表异常</th><td>${data.lastResult.anomalyCount || 0}</td></tr>
            <tr><th>数据质量异常</th><td>${data.lastResult.dataQualityAnomalyCount || 0}</td></tr>
          </table>
        ` : `<p class="muted">暂无本地巡检结果。</p>`}
      </section>
      <section class="panel">
        <h2 class="panel-title">国家覆盖</h2>
        <table>
          <thead><tr><th>国家</th><th>状态</th><th>看板</th><th>卡片</th><th>异常</th></tr></thead>
          <tbody>
            ${(data.countrySummaries || []).map((country) => `
              <tr>
                <td>${country.name} (${country.code})</td>
                <td><span class="badge ${country.status === "ready" ? "ok" : "warn"}">${country.status}</span></td>
                <td>${country.dashboardCount}</td>
                <td>${country.cardCount}</td>
                <td>${country.anomalyCount}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
    </div>
  `;
}

function metric(label, value) {
  return `
    <div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    </div>
  `;
}

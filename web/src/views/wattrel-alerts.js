import { apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";

export function renderWattrelAlerts(root) {
  const result = state.wattrelCurrentResult;

  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">Wattrel 告警</h1>
        <p class="page-note">打开页面会直接查询当前 Wattrel 告警，按国家展示异常数量、目标表和具体异常内容。</p>
      </div>
      ${renderWattrelHeroStats(result)}
    </div>

    <section class="panel wattrel-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">当前告警看板</h2>
        <p class="muted">按国家连接 Wattrel 数据库并实时查询 <code>wattrel_quality_result</code> 当前告警。</p>
        </div>
        <div class="wattrel-button-row">
          <button id="refresh-wattrel-current" class="primary">刷新真实数据</button>
        </div>
      </div>

      ${renderWattrelStatus()}
      ${result ? renderWattrelCurrentResult(result) : renderWattrelLoadingGuide()}
    </section>
  `;

  root.querySelector("#refresh-wattrel-current")?.addEventListener("click", () => {
    void loadWattrelCurrent(root, { force: true });
  });
  root.querySelectorAll("[data-wattrel-country]").forEach((button) => {
    button.addEventListener("click", () => {
      state.wattrelSelectedCountryCode = button.getAttribute("data-wattrel-country") || "";
      renderWattrelAlerts(root);
      root.querySelector("#wattrel-country-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  if (!state.wattrelCurrentLoaded && state.wattrelCurrentStatus?.type !== "loading") {
    void loadWattrelCurrent(root);
  }
}

async function loadWattrelCurrent(root) {
  state.wattrelQueryStatus = null;
  state.wattrelCurrentStatus = {
    type: "loading",
    title: "正在查询当前 Wattrel 告警",
    detail: "正在按国家实时查询 wattrel_quality_result 当前告警。",
  };
  state.wattrelQueryError = "";
  renderWattrelAlerts(root);
  try {
    state.wattrelCurrentResult = await apiPost("/api/wattrel/current", {});
    state.wattrelCurrentLoaded = true;
    ensureWattrelSelectedCountry(state.wattrelCurrentResult);
    state.wattrelCurrentStatus = {
      type: "success",
      title: state.wattrelCurrentResult.summary?.anomalyCount > 0 ? "当前 Wattrel 告警已更新" : "当前无 Wattrel 告警",
      detail: buildCurrentStatusDetail(state.wattrelCurrentResult),
    };
  } catch (error) {
    state.wattrelQueryError = error.payload?.errors?.join("\n") || error.message;
    state.wattrelCurrentStatus = {
      type: "error",
      title: "Wattrel 当前告警查询失败",
      detail: "请检查 config/wattrel.config.json、数据库网络、账号权限和 SQL 配置。",
    };
  }
  renderWattrelAlerts(root);
}

function renderWattrelHeroStats(result) {
  const summary = result?.summary || {};
  return `
    <div class="hero-stats" aria-label="Wattrel 告警概览">
      <article>
        <span>当前告警</span>
        <strong>${escapeHtml(summary.anomalyCount ?? "-")}</strong>
      </article>
      <article>
        <span>已配置国家</span>
        <strong>${escapeHtml(summary.configuredCountryCount ?? "-")}</strong>
      </article>
      <article>
        <span>目标表</span>
        <strong>${escapeHtml(summary.targetTableCount ?? summary.tableCount ?? "-")}</strong>
      </article>
      <article>
        <span>查询失败</span>
        <strong>${escapeHtml(summary.failedCountryCount ?? "-")}</strong>
      </article>
      <article>
        <span>更新时间</span>
        <strong>${escapeHtml(formatDateTime(result?.checkedAt) || "-")}</strong>
      </article>
    </div>
  `;
}

function renderWattrelStatus() {
  const status = state.wattrelCurrentStatus;
  if (!status) {
    return "";
  }
  return `
    <div class="sandbox-status ${escapeHtml(status.type)}">
      <strong>${escapeHtml(status.title)}</strong>
      <span>${escapeHtml(status.detail || "")}</span>
      ${status.type === "error" ? `<pre>${escapeHtml(state.wattrelQueryError || "-")}</pre>` : ""}
    </div>
  `;
}

function renderWattrelLoadingGuide() {
  return `
    <div class="wattrel-guide-grid">
      <article>
        <strong>1. 自动查询真实数据</strong>
        <span>进入页面会调用 <code>POST /api/wattrel/current</code> 查询各国 Wattrel。</span>
      </article>
      <article>
        <strong>2. 按国家并发查询</strong>
        <span>后端会按国家连接跳板机或数据库，读取当前 <code>wattrel_quality_result</code> 告警。</span>
      </article>
      <article>
        <strong>3. 点击国家看明细</strong>
        <span>下方国家卡片可点击，直接查看该国家的目标表和具体异常内容。</span>
      </article>
    </div>
  `;
}

function renderWattrelCurrentResult(result) {
  const anomalies = result.anomalies || [];
  if (!anomalies.length) {
    return `
      <div class="auto-summary">
        ${summaryItem("当前告警", 0)}
        ${summaryItem("国家", result.summary?.countryCount || 0)}
        ${summaryItem("已配置国家", result.summary?.configuredCountryCount || 0)}
        ${summaryItem("查询失败", result.summary?.failedCountryCount || 0)}
      </div>
      ${renderWattrelCountryOverview(result)}
      ${renderWattrelCountryDetails(result)}
      <p class="${result.configEnabled === false ? "muted" : "success"}">${result.configEnabled === false ? "当前没有已配置的 Wattrel 国家连接。部署到 n8n 时请按国家传入 WATTREL_国家代码_DB_* 环境变量，或在 config/wattrel.config.json 的 countries 中配置。" : "已连接的国家当前没有 Wattrel 告警。"}</p>
    `;
  }
  return `
    <div class="auto-summary">
    ${summaryItem("查询行数", result.rowCount || 0)}
    ${summaryItem("当前告警", result.summary?.anomalyCount || anomalies.length)}
    ${summaryItem("涉及国家", result.summary?.countryCount || 0)}
    ${summaryItem("目标表", result.summary?.targetTableCount || result.topTables?.length || 0)}
    </div>
    ${renderWattrelCountryOverview(result)}
    ${renderWattrelCountryDetails(result)}
  `;
}

function renderWattrelCountryOverview(result) {
  const countries = result.countries || [];
  if (!countries.length) {
    return "";
  }
  return `
    <section class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">各国当前告警</h2>
          <p class="muted">点击国家卡片查看该国家当前告警明细。</p>
        </div>
      </div>
      <div class="wattrel-country-grid">
        ${countries.map((country) => {
          const selected = String(country.countryCode || "") === String(state.wattrelSelectedCountryCode || "");
          return `
          <button type="button" class="wattrel-country-card ${selected ? "is-selected" : ""}" data-wattrel-country="${escapeHtml(country.countryCode || "")}">
            <div>
              <strong>${escapeHtml(countryDisplayName(country))}</strong>
              <span>${escapeHtml(countryStatusLabel(country))} · ${escapeHtml(country.anomalyCount || 0)} 条告警，${escapeHtml(country.tableCount || 0)} 张目标表</span>
            </div>
            <p>${escapeHtml(country.error || (country.topTables || []).slice(0, 3).map((item) => `${item.name} ${item.count}条`).join("，") || (country.configured ? "暂无当前告警" : "未配置该国家 Wattrel 连接"))}</p>
            <small>${selected ? "正在查看" : "查看明细"}</small>
          </button>
        `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderWattrelCountryDetails(result) {
  const country = getSelectedWattrelCountry(result);
  if (!country) {
    return "";
  }
  return `
    <section id="wattrel-country-detail" class="sub-panel wattrel-country-detail-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">${escapeHtml(countryDisplayName(country))} 当前告警明细</h2>
          <p class="muted">展示该国家的连接状态、主要目标表和具体异常内容。</p>
        </div>
      </div>
      ${renderWattrelCountryDetail(country)}
    </section>
  `;
}

function renderWattrelCountryDetail(country) {
  const anomalies = country.anomalies || [];
  return `
    <div class="wattrel-country-detail">
      <header>
        <span>${escapeHtml(countryDisplayName(country))}</span>
        <strong>${escapeHtml(countryStatusLabel(country))}</strong>
        <em>${escapeHtml(country.anomalyCount || 0)} 条告警</em>
      </header>
      ${country.error ? `<p class="danger-text">${escapeHtml(country.error)}</p>` : ""}
      ${!country.configured ? `<p class="muted">该国家尚未配置 Wattrel 数据库连接。可配置 <code>WATTREL_${escapeHtml(String(country.countryCode || "").toUpperCase())}_DB_HOST</code>、<code>WATTREL_${escapeHtml(String(country.countryCode || "").toUpperCase())}_DB_USER</code>、<code>WATTREL_${escapeHtml(String(country.countryCode || "").toUpperCase())}_DB_NAME</code> 等环境变量。</p>` : ""}
      ${country.configured && !anomalies.length && !country.error ? `<p class="success">该国家当前没有 Wattrel 告警。</p>` : ""}
      ${anomalies.length ? `
        <div class="wattrel-country-anomaly-list">
          ${anomalies.slice(0, 20).map((item, index) => renderWattrelAnomalyDetail(item, index)).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderWattrelAnomalyDetail(item, index) {
  return `
    <article class="wattrel-anomaly-card">
      <div class="wattrel-anomaly-head">
        <div>
          <small>#${escapeHtml(index + 1)}</small>
          <strong>${escapeHtml(item.name || "未命名校验")}</strong>
          <span>${escapeHtml(item.message || buildAnomalyMessage(item))}</span>
        </div>
        ${renderDiffCell(item.diff)}
      </div>

      <div class="wattrel-anomaly-grid">
        ${renderAnomalyField("底表 / 源表", formatTableName(item.srcDb, item.srcTbl))}
        ${renderAnomalyField("目标表", formatTableName(item.destDb, item.destTbl || item.cardTitle))}
        ${renderAnomalyField("时间范围", item.window || "-")}
        ${renderAnomalyField("期望值", formatWattrelValue(item.expectedValue))}
        ${renderAnomalyField("实际值", formatWattrelValue(item.actualValue))}
        ${renderAnomalyField("差值", formatWattrelValue(item.diff))}
      </div>

      ${item.srcError || item.destError ? `
        <div class="wattrel-error-box">
          ${item.srcError ? `<p><strong>源端错误：</strong>${escapeHtml(item.srcError)}</p>` : ""}
          ${item.destError ? `<p><strong>目标端错误：</strong>${escapeHtml(item.destError)}</p>` : ""}
        </div>
      ` : ""}

      ${renderSqlBlock("源端校验 SQL", item.srcSql)}
      ${renderSqlBlock("目标校验 SQL", item.destSql)}
      ${renderSqlBlock("补充 SQL", item.checkSql)}
    </article>
  `;
}

function renderAnomalyField(label, value) {
  return `
    <div class="wattrel-anomaly-field">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value || "-")}">${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function renderSqlBlock(label, sql) {
  const content = String(sql || "").trim();
  if (!content) {
    return "";
  }
  return `
    <details class="wattrel-sql-detail">
      <summary>${escapeHtml(label)}</summary>
      <pre>${escapeHtml(content)}</pre>
    </details>
  `;
}

function summaryItem(label, value) {
  return `
    <div class="info-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
  `;
}

function buildCurrentStatusDetail(result = {}) {
  const summary = result.summary || {};
  if (result.configEnabled === false) {
    return "当前没有已配置的国家级 Wattrel 数据库连接。部署到 n8n 后请按国家注入连接参数。";
  }
  if (!summary.anomalyCount) {
    return `查询 ${result.rowCount || 0} 行，没有当前告警。`;
  }
  const countryText = (result.countries || [])
    .slice(0, 4)
    .map((country) => `${countryDisplayName(country)} ${country.anomalyCount}条`)
    .join("，");
  return `当前 ${summary.anomalyCount} 条告警，涉及 ${summary.countryCount} 个国家、${summary.targetTableCount || summary.tableCount} 张目标表。${countryText ? `主要分布：${countryText}` : ""}`;
}

function buildAnomalyMessage(item = {}) {
  const pieces = [];
  if (item.name) {
    pieces.push(`校验项「${item.name}」`);
  }
  if (item.destTbl) {
    pieces.push(`目标表 ${item.destTbl}`);
  }
  if (item.expectedValue !== undefined || item.actualValue !== undefined) {
    pieces.push(`期望 ${formatWattrelValue(item.expectedValue)}，实际 ${formatWattrelValue(item.actualValue)}`);
  }
  if (item.diff !== undefined) {
    pieces.push(`差值 ${formatWattrelValue(item.diff)}`);
  }
  return pieces.join("，") || "Wattrel 当前告警";
}

function ensureWattrelSelectedCountry(result = {}) {
  const country = getSelectedWattrelCountry(result);
  state.wattrelSelectedCountryCode = country?.countryCode || "";
}

function getSelectedWattrelCountry(result = {}) {
  const countries = result.countries || [];
  if (!countries.length) {
    return null;
  }
  const selectedCode = state.wattrelSelectedCountryCode || "";
  return countries.find((country) => String(country.countryCode || "") === String(selectedCode))
    || countries.find((country) => Number(country.anomalyCount || 0) > 0)
    || countries[0];
}

function countryDisplayName(item = {}) {
  return [item.countryName, item.countryCode].filter(Boolean).join(" / ") || "未归属";
}

function countryStatusLabel(country = {}) {
  if (country.status === "failed") {
    return "查询失败";
  }
  if (!country.configured || country.status === "unconfigured") {
    return "未配置连接";
  }
  return "已连接";
}

function renderDiffCell(value) {
  const text = formatWattrelValue(value);
  const numberValue = Number(value);
  const className = Number.isFinite(numberValue) && numberValue !== 0 ? "pill warning" : "pill";
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function formatTableName(db, table) {
  const dbText = String(db || "").trim();
  const tableText = String(table || "").trim();
  if (dbText && tableText) {
    return `${dbText}.${tableText}`;
  }
  return tableText || dbText || "-";
}

function formatWattrelValue(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
  }
  return String(value);
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(/\//g, "/");
}

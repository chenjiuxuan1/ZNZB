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
          <p class="muted">按国家连接 Wattrel 数据库并查询 <code>wattrel_quality_result</code> 当前告警；部署到 n8n 时可以用国家级环境变量注入连接。</p>
        </div>
        <div class="wattrel-button-row">
          <button id="load-wattrel-mock" class="secondary">加载模拟数据</button>
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
  root.querySelector("#load-wattrel-mock")?.addEventListener("click", () => {
    loadWattrelMock(root);
  });
  root.querySelectorAll("[data-wattrel-country]").forEach((button) => {
    button.addEventListener("click", () => {
      state.wattrelSelectedCountryCode = button.getAttribute("data-wattrel-country") || "";
      renderWattrelAlerts(root);
      root.querySelector("#wattrel-country-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  if (!state.wattrelCurrentLoaded && state.wattrelCurrentStatus?.type !== "loading") {
    loadWattrelMock(root);
  }
}

function loadWattrelMock(root) {
  state.wattrelCurrentResult = buildMockWattrelResult();
  state.wattrelCurrentLoaded = true;
  ensureWattrelSelectedCountry(state.wattrelCurrentResult);
  state.wattrelCurrentStatus = {
    type: "success",
    title: "已加载 Wattrel 模拟告警",
    detail: "当前展示的是本地模拟数据，用于校准页面结构和交互效果，不会访问数据库。",
  };
  state.wattrelQueryError = "";
  renderWattrelAlerts(root);
}

async function loadWattrelCurrent(root) {
  state.wattrelQueryStatus = null;
  state.wattrelCurrentStatus = {
    type: "loading",
    title: "正在读取当前 Wattrel 告警",
    detail: "正在按国家读取当前告警快照。",
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
        <strong>1. 先看模拟效果</strong>
        <span>点击“加载模拟数据”可以直接预览国家汇总、目标表 Top 和国家明细。</span>
      </article>
      <article>
        <strong>2. 接入真实数据库</strong>
        <span>点击“刷新真实数据”会调用 <code>POST /api/wattrel/current</code> 查询各国 Wattrel。</span>
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
    ${renderWattrelTopTables(result)}
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
          ${anomalies.slice(0, 20).map((item) => `
            <article>
              <strong>${escapeHtml(item.destTbl || item.cardTitle || "未知目标表")}</strong>
              <span>${escapeHtml(item.name || "未命名校验")}：期望 ${escapeHtml(formatWattrelValue(item.expectedValue))}，实际 ${escapeHtml(formatWattrelValue(item.actualValue))}，差值 ${escapeHtml(formatWattrelValue(item.diff))}</span>
              <small>${escapeHtml(item.window || item.message || "-")}</small>
            </article>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderWattrelTopTables(result) {
  const tables = (result.topTables || []).slice(0, 10);
  if (!tables.length) {
    return "";
  }
  return `
    <section class="sub-panel wattrel-top-table-panel">
      <h2 class="panel-title">异常目标表 Top ${escapeHtml(tables.length)}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>目标表</th>
              <th>异常数</th>
              <th>主要校验</th>
              <th>涉及国家</th>
            </tr>
          </thead>
          <tbody>
            ${tables.map((table) => `
              <tr>
                <td>${escapeHtml(table.name)}</td>
                <td>${escapeHtml(table.count)}</td>
                <td>${escapeHtml((table.checks || []).slice(0, 4).join("、") || "-")}</td>
                <td>${escapeHtml((table.countries || []).slice(0, 4).join("、") || "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
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

function buildMockWattrelResult() {
  const checkedAt = new Date().toISOString();
  const anomalies = [
    mockWattrelAnomaly({
      countryCode: "CN",
      countryName: "中国",
      destTbl: "dws_cst_pay_cost_statistics",
      srcTbl: "dwd_cst_pay_cost_detail",
      name: "支付成本金额校验",
      expectedValue: 2368584.265999,
      actualValue: 0,
      diff: 2368584.265999,
      window: "2026-07-04 00:00:00 至 2026-07-05 00:00:00",
      message: "目标表当天无数据，源表存在 2,368,584.265999，疑似先删后插任务失败。",
    }),
    mockWattrelAnomaly({
      countryCode: "CN",
      countryName: "中国",
      destTbl: "dwb_dd_onloan_balance",
      srcTbl: "dwb_asset_info",
      name: "月快照放款金额校验",
      expectedValue: 52834501728,
      actualValue: 52834506428,
      diff: -4700,
      window: "快照日 2026-07-01",
      message: "月快照金额与源表当前存量口径差 4,700，疑似源表修数后快照未重刷。",
    }),
    mockWattrelAnomaly({
      countryCode: "INE",
      countryName: "印尼",
      destTbl: "dwd_asset_withhold_detail",
      srcTbl: "ods_repay_withhold_detail, ods_repay_history_withhold_detail_his",
      name: "代扣明细数量校验",
      expectedValue: 4657696,
      actualValue: 4691425,
      diff: -33729,
      window: "2026-04-05 至 2026-07-04",
      message: "DWD 比 ODS+历史表多 33,729 条，疑似 ODS 删数后 DWD 孤儿数据未清理。",
    }),
    mockWattrelAnomaly({
      countryCode: "INE",
      countryName: "印尼",
      destTbl: "dwd_asset_withhold_request",
      srcTbl: "ods_repay_withhold_request",
      name: "代扣请求数量校验",
      expectedValue: 1212966,
      actualValue: 1219544,
      diff: -6578,
      window: "2026-04-05 至 2026-07-04",
      message: "DWD 多 6,578 条，源端删除后目标表增量逻辑未同步删除。",
    }),
    mockWattrelAnomaly({
      countryCode: "PH",
      countryName: "菲律宾",
      destTbl: "ads_3602_asset_flow_d",
      srcTbl: "dwd_asset_biz_report",
      name: "资金流入流出金额校验",
      expectedValue: 33602309.46,
      actualValue: 34626129.27,
      diff: -1023819.81,
      window: "2026-06-01 至 2026-06-03",
      message: "目标金额比源表多 1,023,819.81，需检查 ADS 是否存在历史残留或口径外数据。",
    }),
    mockWattrelAnomaly({
      countryCode: "MX",
      countryName: "墨西哥",
      destTbl: "dwd_cst_dataproxy_request_out",
      srcTbl: "ods_r1_request_out",
      name: "数据代理请求数量校验",
      expectedValue: 421555,
      actualValue: 361377,
      diff: 60178,
      window: "2026-06-28 至 2026-07-05",
      message: "目标表少 60,178 条，疑似 DWD 补刷窗口未覆盖完整 ODS 分区。",
    }),
  ];
  const countries = [
    mockWattrelCountry("CN", "中国", anomalies),
    mockWattrelCountry("INE", "印尼", anomalies),
    mockWattrelCountry("PH", "菲律宾", anomalies),
    mockWattrelCountry("TH", "泰国", anomalies),
    mockWattrelCountry("PK", "巴基斯坦", anomalies, { status: "failed", error: "模拟：数据库连接超时，请检查网络或账号权限。" }),
    mockWattrelCountry("MX", "墨西哥", anomalies),
  ];
  const topTables = summarizeMockWattrelTables(anomalies);
  return {
    ok: true,
    source: "wattrel",
    mock: true,
    configEnabled: true,
    connectionMode: "mock",
    checkedAt,
    rowCount: anomalies.length,
    summary: {
      countryCount: countries.length,
      configuredCountryCount: countries.filter((country) => country.configured).length,
      failedCountryCount: countries.filter((country) => country.status === "failed").length,
      anomalyCount: anomalies.length,
      tableCount: topTables.length,
      targetTableCount: topTables.length,
    },
    countries,
    topTables,
    anomalies,
  };
}

function mockWattrelAnomaly(input) {
  return {
    source: "wattrel",
    type: "wattrelQualityAlert",
    dashboardTitle: "Wattrel 数据质量",
    cardTitle: input.destTbl,
    severity: "warning",
    checkedAt: new Date().toISOString(),
    ...input,
  };
}

function mockWattrelCountry(countryCode, countryName, anomalies, options = {}) {
  const items = anomalies.filter((item) => item.countryCode === countryCode);
  const topTables = summarizeMockWattrelTables(items).slice(0, 5);
  const status = options.status || "success";
  return {
    countryCode,
    countryName,
    configured: options.configured ?? true,
    status,
    rowCount: items.length,
    anomalyCount: items.length,
    tableCount: topTables.length,
    topTables,
    anomalies: items,
    error: options.error || null,
  };
}

function summarizeMockWattrelTables(anomalies = []) {
  const groups = new Map();
  for (const item of anomalies) {
    const name = item.destTbl || item.cardTitle || "未知目标表";
    if (!groups.has(name)) {
      groups.set(name, {
        name,
        count: 0,
        checks: new Set(),
        countries: new Set(),
      });
    }
    const group = groups.get(name);
    group.count += 1;
    if (item.name) {
      group.checks.add(item.name);
    }
    group.countries.add(countryDisplayName(item));
  }
  return [...groups.values()].map((item) => ({
    name: item.name,
    count: item.count,
    checks: [...item.checks],
    countries: [...item.countries],
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

import { apiGet, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";
import { parseAnomalyMessage } from "./batch-check.js";

const FLUCTUATION_TYPES = new Set([
  "completeDayChange",
  "robustCompleteDayChange",
  "intradayTimePointChange",
  "intradaySameTimeChange",
  "latestNonZeroToZero",
]);

const CHINA_SUPPRESSED_ANOMALY_TYPES = new Set([
  "noData",
  "emptyMetrics",
  "latestNonZeroToZero",
  "latestZeroRate",
  "notEmpty",
]);

export function renderFluctuationVisual(root) {
  const model = buildFluctuationVisualModel(state.batchHistory, state.countries?.countries || []);
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">波动图谱</h1>
        <p class="page-note">按国家展示今天更新的波动异常指标；点击图旁的点，查看该指标报警前十几天的真实历史走势和异常当天红点。</p>
      </div>
      <div class="hero-stats fluctuation-stats">
        <article><span>国家</span><strong>${escapeHtml(model.countryCount)}</strong></article>
        <article><span>波动点</span><strong>${escapeHtml(model.anomalyCount)}</strong></article>
        <article><span>巡检时间</span><strong>${escapeHtml(formatDateTime(model.run?.startedAt || model.run?.finishedAt) || "-")}</strong></article>
      </div>
    </div>

    ${renderFluctuationStatus()}
    ${model.run ? renderFluctuationCountries(model) : renderEmptyFluctuationState()}
  `;

  root.querySelector("#refresh-fluctuation-history")?.addEventListener("click", () => {
    void reloadFluctuationHistory(root);
  });
  root.querySelectorAll("[data-fluctuation-country]").forEach((button) => {
    button.addEventListener("click", () => {
      state.fluctuationVisualCountryCode = button.getAttribute("data-fluctuation-country") || "";
      renderFluctuationVisual(root);
    });
  });
  root.querySelectorAll("[data-fluctuation-point]").forEach((button) => {
    button.addEventListener("click", () => {
      const countryCode = button.getAttribute("data-country") || "";
      const index = Number(button.getAttribute("data-index") || 0);
      state.fluctuationVisualSelected = {
        ...(state.fluctuationVisualSelected || {}),
        [countryCode]: index,
      };
      renderFluctuationVisual(root);
    });
  });

  if (!state.fluctuationVisualLoaded && state.batchHistoryStatus?.type !== "loading") {
    void reloadFluctuationHistory(root);
  }
  const selected = getSelectedModelAnomaly(model);
  if (selected && !hasRealSeries(selected)) {
    void hydrateFluctuationSeries(root, selected);
  }
}

async function reloadFluctuationHistory(root) {
  state.batchHistoryStatus = {
    type: "loading",
    title: "正在刷新波动图谱",
    detail: "正在读取最近的巡检历史，用于生成各国异常指标走势。",
  };
  renderFluctuationVisual(root);
  try {
    state.batchHistory = await apiGet("/api/batch-history?status=anomaly&limit=1");
    state.fluctuationVisualLoaded = true;
    state.batchHistoryStatus = null;
  } catch (error) {
    state.batchHistoryStatus = {
      type: "error",
      title: "波动图谱刷新失败",
      detail: error.payload?.errors?.join("\n") || error.message,
    };
  }
  renderFluctuationVisual(root);
}

function renderFluctuationStatus() {
  const status = state.batchHistoryStatus;
  return `
    <section class="panel fluctuation-toolbar">
      <div>
        <h2 class="panel-title">异常走势视图</h2>
        <p class="muted">绿色折线来自巡检时保存的真实查询结果，红色表示报警当天的数据。旧历史没有真实序列时不画参考线，避免误判。</p>
      </div>
      <button id="refresh-fluctuation-history" class="primary" type="button">刷新历史</button>
    </section>
    ${status ? `
      <div class="sandbox-status ${escapeHtml(status.type)}">
        <strong>${escapeHtml(status.title)}</strong>
        <span>${escapeHtml(status.detail || "")}</span>
      </div>
    ` : ""}
  `;
}

function renderEmptyFluctuationState() {
  return `
    <section class="panel empty-state">
      <h2 class="panel-title">暂无巡检历史</h2>
      <p class="muted">等定时巡检或手动巡检产生历史记录后，这里会按国家生成波动图谱。</p>
    </section>
  `;
}

function renderFluctuationCountries(model) {
  if (!model.countries.length) {
    return `
      <section class="panel empty-state">
        <h2 class="panel-title">今日巡检没有波动异常</h2>
        <p class="success">今天更新的巡检记录里没有可绘制的波动点。</p>
      </section>
    `;
  }

  const selectedCountry = getSelectedFluctuationCountry(model.countries);
  return `
    <section class="panel fluctuation-country-selector">
      <div>
        <h2 class="panel-title">选择国家</h2>
        <p class="muted">每次只展示一个国家的大图，避免多个国家图表挤在同一页。</p>
      </div>
      <div class="fluctuation-country-buttons">
        ${model.countries.map((country) => {
          const active = country.countryCode === selectedCountry.countryCode;
          return `
            <button class="${active ? "active" : ""}" type="button" data-fluctuation-country="${escapeHtml(country.countryCode)}">
              <strong>${escapeHtml(country.countryName || country.countryCode || "-")}</strong>
              <span>${escapeHtml(country.countryCode || "-")} · ${escapeHtml(country.anomalies.length)} 点</span>
            </button>
          `;
        }).join("")}
      </div>
    </section>
    <div class="fluctuation-country-focus">
      ${renderFluctuationCountry(selectedCountry)}
    </div>
  `;
}

function getSelectedFluctuationCountry(countries = []) {
  const selectedCode = String(state.fluctuationVisualCountryCode || "").toUpperCase();
  const selected = countries.find((country) => String(country.countryCode || "").toUpperCase() === selectedCode);
  const fallback = selected || countries[0] || null;
  if (fallback && state.fluctuationVisualCountryCode !== fallback.countryCode) {
    state.fluctuationVisualCountryCode = fallback.countryCode;
  }
  return fallback;
}

function renderFluctuationCountry(country) {
  const selectedIndex = getDisplayAnomalyIndex(country);
  const selected = country.anomalies[selectedIndex] || country.anomalies[0];
  const chart = buildChart(selected);
  const drawableCount = country.anomalies.filter(hasRealSeries).length;
  const seriesState = state.fluctuationVisualSeries?.[selected.seriesKey];
  return `
    <article class="panel fluctuation-country-card">
      <div class="fluctuation-country-head">
        <div>
          <h2 class="panel-title">${escapeHtml(country.countryName || country.countryCode || "-")}</h2>
          <p class="muted">${escapeHtml(country.countryCode || "-")} · ${escapeHtml(country.anomalies.length)} 个波动指标${drawableCount < country.anomalies.length ? `，${escapeHtml(drawableCount)} 个已保存真实序列` : ""}</p>
        </div>
        <span class="badge warn">${escapeHtml(country.anomalies.length)} 点</span>
      </div>
      <div class="fluctuation-visual-body">
        <div class="fluctuation-chart-wrap">
          ${renderLineChart(chart)}
          ${seriesState?.type === "loading" ? `<div class="fluctuation-chart-note">正在按看板 URL 拉取最近历史数据...</div>` : ""}
          ${seriesState?.type === "error" ? `<div class="fluctuation-chart-note error">${escapeHtml(seriesState.detail || "历史数据拉取失败")}</div>` : ""}
          <div class="fluctuation-chart-caption">
            <strong>${escapeHtml(selected.metricLabel)}</strong>
            <span>${escapeHtml(selected.dashboardTitle)} / ${escapeHtml(selected.cardTitle)}</span>
          </div>
        </div>
        <div class="fluctuation-point-rail" aria-label="${escapeHtml(country.countryCode)} 波动点">
          ${country.anomalies.map((anomaly, index) => `
            <button
              class="${index === selectedIndex ? "active" : ""}"
              type="button"
              title="${escapeHtml(anomaly.metricLabel)}"
              data-fluctuation-point
              data-country="${escapeHtml(country.countryCode)}"
              data-index="${escapeHtml(index)}"
            >
              <span></span>
            </button>
          `).join("")}
        </div>
      </div>
      <div class="fluctuation-selected-detail">
        <div>${renderDetailField("当前值", selected.detail.currentValue || "-")}</div>
        <div>${renderDetailField("基准值", selected.detail.baselineValue || "-")}</div>
        <div>${renderDetailField("变化", selected.detail.changeValue || "-")}</div>
        <div>${renderDetailField("时间", selected.detail.timeText || "-")}</div>
      </div>
    </article>
  `;
}

function renderDetailField(label, value) {
  return `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
}

function renderLineChart(chart) {
  if (!chart.points.length) {
    return `<div class="fluctuation-chart-empty">已读到这条异常，正在尝试按保存的看板 URL 回查最近历史数据；如果无法匹配，会在下方显示原因。</div>`;
  }
  const width = 560;
  const height = 260;
  const pad = { top: 22, right: 24, bottom: 34, left: 52 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const minValue = Math.min(...chart.points.map((point) => point.value));
  const maxValue = Math.max(...chart.points.map((point) => point.value));
  const span = maxValue - minValue || Math.max(1, Math.abs(maxValue || 1));
  const yMin = minValue - span * 0.12;
  const yMax = maxValue + span * 0.12;

  const coords = chart.points.map((point, index) => {
    const x = pad.left + (chart.points.length === 1 ? plotWidth : (index / (chart.points.length - 1)) * plotWidth);
    const y = pad.top + ((yMax - point.value) / (yMax - yMin || 1)) * plotHeight;
    return { ...point, x, y };
  });
  const normalCoords = coords.filter((point) => !point.anomaly);
  const anomalyPoint = coords.find((point) => point.anomaly) || coords[coords.length - 1];
  const path = normalCoords.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const fullPath = coords.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const yTicks = buildTicks(yMin, yMax, 4);
  const percentScale = resolvePercentDisplayScale(chart);

  return `
    <svg class="fluctuation-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">
      <rect x="0" y="0" width="${width}" height="${height}" rx="8"></rect>
      ${yTicks.map((tick) => {
        const y = pad.top + ((yMax - tick) / (yMax - yMin || 1)) * plotHeight;
        return `
          <line class="grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line>
          <text class="axis-label" x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatChartValue(tick, chart.percent, percentScale))}</text>
        `;
      }).join("")}
      <path class="full-line" d="${fullPath}"></path>
      ${path ? `<path class="normal-line" d="${path}"></path>` : ""}
      ${coords.map((point) => `
        <circle class="${point.anomaly ? "anomaly-dot" : "normal-dot"}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.anomaly ? 5.8 : 3.8}">
          <title>${escapeHtml(point.label || "")} ${escapeHtml(formatChartValue(point.value, chart.percent, percentScale))}</title>
        </circle>
      `).join("")}
      <text class="x-label" x="${pad.left}" y="${height - 10}">${escapeHtml(coords[0]?.label || "")}</text>
      <text class="x-label" x="${width - pad.right}" y="${height - 10}" text-anchor="end">${escapeHtml(anomalyPoint?.label || "")}</text>
    </svg>
  `;
}

function buildFluctuationVisualModel(history, countries = [], options = {}) {
  const today = options.today || getBeijingDateKey(new Date());
  const todayRuns = (history?.runs || []).filter((item) => isRunUpdatedOnDate(item, today));
  const run = todayRuns.find((item) => collectFluctuationAnomalies(item, countries).length) || todayRuns[0] || null;
  const anomalies = collectFluctuationAnomalies(run, countries);
  const byCountry = new Map();
  for (const anomaly of anomalies) {
    if (!byCountry.has(anomaly.countryCode)) {
      byCountry.set(anomaly.countryCode, {
        countryCode: anomaly.countryCode,
        countryName: anomaly.countryName,
        anomalies: [],
      });
    }
    byCountry.get(anomaly.countryCode).anomalies.push(anomaly);
  }
  const countryModels = [...byCountry.values()].sort((a, b) => b.anomalies.length - a.anomalies.length);
  return {
    run,
    today,
    countries: countryModels,
    countryCount: countryModels.length,
    anomalyCount: anomalies.length,
  };
}

function isRunUpdatedOnDate(run = {}, dateKey) {
  const candidates = [
    run.finishedAt,
    run.startedAt,
    run.checkedAt,
    run.updatedAt,
  ];
  return candidates.some((value) => getBeijingDateKey(value) === dateKey);
}

function getBeijingDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function collectFluctuationAnomalies(run, countries = []) {
  if (!run) return [];
  const countryNames = new Map((countries || []).map((country) => [String(country.code || country.countryCode || "").toUpperCase(), country.name || country.countryName || ""]));
  const rows = [];
  for (const countryRun of run.runs || []) {
    const countryCode = String(countryRun.countryCode || "").toUpperCase();
    const countryName = countryRun.countryName || countryNames.get(countryCode) || countryCode;
    for (const [anomalyIndex, anomaly] of (countryRun.result?.anomalies || []).entries()) {
      const detail = parseAnomalyMessage(anomaly.message || "", anomaly.type || "");
      if (!isFluctuationAnomaly(anomaly, detail, countryCode)) {
        continue;
      }
      const seriesKey = buildSeriesKey(run.id, countryCode, anomalyIndex, anomaly);
      const hydrated = state.fluctuationVisualSeries?.[seriesKey];
      rows.push({
        ...anomaly,
        countryCode,
        countryName,
        runId: run.id || "",
        anomalyIndex,
        seriesKey,
        hydratedSeries: hydrated?.series || null,
        detail,
        metricLabel: buildMetricLabel(anomaly, detail),
      });
    }
  }
  return rows;
}

function isFluctuationAnomaly(anomaly, detail, countryCode = "") {
  const type = String(anomaly?.type || "");
  const text = `${anomaly?.message || ""} ${detail?.reason || ""}`;
  if (String(countryCode || "").toUpperCase() === "CN" && CHINA_SUPPRESSED_ANOMALY_TYPES.has(type)) {
    return false;
  }
  if (["noData", "emptyMetrics", "queryError", "metabaseConfigError", "metabaseStalePublicLink", "notEmpty"].includes(type)) {
    return false;
  }
  return FLUCTUATION_TYPES.has(type) || /波动|变化|降为|到/.test(text);
}

function buildMetricLabel(anomaly, detail) {
  const parts = [detail.metricName, detail.dimensionText]
    .map(cleanMetricLabelPart)
    .filter(Boolean);
  if (parts.length) {
    return parts.join(" · ");
  }

  const fallback = [
    anomaly.column,
    anomaly.metricColumn,
    anomaly.metricName,
    anomaly.cardTitle,
    anomaly.dashboardTitle,
  ].map(cleanMetricLabelPart).find(Boolean);
  return fallback || "未命名指标";
}

function cleanMetricLabelPart(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "-") return "";
  if (/^[+-]?\d+(?:\.\d+)?%?$/.test(text)) return "";
  return text;
}

function buildChart(anomaly) {
  const realPoints = normalizeSeries(anomaly);
  const points = realPoints;
  const percent = points.some((point) => point.percent) || isPercentMetric(anomaly);
  return {
    title: anomaly.metricLabel,
    percent,
    points: points.map((point, index) => ({
      ...point,
      anomaly: point.anomaly || index === points.length - 1,
    })),
  };
}

function isPercentMetric(anomaly = {}) {
  const metricText = [
    anomaly.metricLabel,
    anomaly.detail?.metricName,
    anomaly.metricName,
    anomaly.metricColumn,
    anomaly.column,
  ].filter(Boolean).join(" ");
  return /(率|占比|转化|逾期|入催|复借|费率|rate|ratio|percent|conversion|overdue)/i.test(metricText);
}

function chooseDisplayAnomalyIndex(anomalies = [], requestedIndex = 0) {
  if (!anomalies.length) return 0;
  const clamped = clampIndex(requestedIndex, anomalies.length);
  if (hasRealSeries(anomalies[clamped])) return clamped;
  const firstDrawable = anomalies.findIndex(hasRealSeries);
  return firstDrawable >= 0 ? firstDrawable : clamped;
}

function getDisplayAnomalyIndex(country) {
  const selectedByCountry = state.fluctuationVisualSelected || {};
  if (Object.prototype.hasOwnProperty.call(selectedByCountry, country.countryCode)) {
    return clampIndex(selectedByCountry[country.countryCode], country.anomalies.length);
  }
  return chooseDisplayAnomalyIndex(country.anomalies, 0);
}

function hasRealSeries(anomaly) {
  return normalizeSeries(anomaly).length > 0;
}

function normalizeSeries(anomaly) {
  const candidate = anomaly.series || anomaly.hydratedSeries || anomaly.history || anomaly.points || anomaly.evidence?.series || anomaly.fluctuation?.history;
  const rawPoints = Array.isArray(candidate) ? candidate : [];
  return rawPoints
    .map((point, index) => {
      const value = parseNumericValue(point.value ?? point.metric ?? point.y ?? point.currentValue);
      if (!Number.isFinite(value)) return null;
      return {
        label: String(point.date || point.statDate || point.x || point.label || `D-${rawPoints.length - index - 1}`),
        value,
        percent: /%/.test(String(point.value ?? point.metric ?? "")),
        anomaly: Boolean(point.anomaly || point.isAnomaly || index === rawPoints.length - 1),
      };
    })
    .filter(Boolean)
    .slice(-16);
}

function getSelectedModelAnomaly(model) {
  const country = getSelectedFluctuationCountry(model.countries || []);
  if (!country) return null;
  const selectedIndex = getDisplayAnomalyIndex(country);
  return country.anomalies[selectedIndex] || country.anomalies[0] || null;
}

async function hydrateFluctuationSeries(root, anomaly) {
  const key = anomaly.seriesKey || buildSeriesKey(anomaly.runId, anomaly.countryCode, anomaly.anomalyIndex, anomaly);
  const current = state.fluctuationVisualSeries?.[key];
  if (current?.type === "loading" || current?.type === "loaded" || current?.type === "error") {
    return;
  }
  state.fluctuationVisualSeries = {
    ...(state.fluctuationVisualSeries || {}),
    [key]: { type: "loading", series: [] },
  };
  renderFluctuationVisual(root);
  try {
    const result = await apiPost("/api/fluctuation-visual/series", {
      anomaly,
      lookbackDays: 45,
      maxPoints: 16,
    });
    state.fluctuationVisualSeries = {
      ...(state.fluctuationVisualSeries || {}),
      [key]: {
        type: result.series?.length ? "loaded" : "error",
        series: result.series || [],
        detail: result.message || "",
      },
    };
  } catch (error) {
    state.fluctuationVisualSeries = {
      ...(state.fluctuationVisualSeries || {}),
      [key]: {
        type: "error",
        series: [],
        detail: error.payload?.errors?.join("\n") || error.message,
      },
    };
  }
  renderFluctuationVisual(root);
}

function buildSeriesKey(runId, countryCode, anomalyIndex, anomaly = {}) {
  return [
    runId || "",
    countryCode || anomaly.countryCode || "",
    anomalyIndex ?? "",
    anomaly.dashboardUuid || "",
    anomaly.cardId ?? "",
    anomaly.dashcardId ?? "",
    anomaly.type || "",
    anomaly.message || "",
  ].join("::");
}

function parseNumericValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  const match = text.replace(/,/g, "").match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return NaN;
  return Number(match[0]);
}

function buildTicks(minValue, maxValue, count) {
  const ticks = [];
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return ticks;
  const step = (maxValue - minValue || 1) / Math.max(1, count - 1);
  for (let index = 0; index < count; index += 1) {
    ticks.push(minValue + step * index);
  }
  return ticks;
}

function resolvePercentDisplayScale(chart = {}) {
  if (!chart.percent) return 1;
  const values = (chart.points || []).map((point) => Math.abs(Number(point.value))).filter(Number.isFinite);
  if (!values.length) return 1;
  return Math.max(...values) <= 1 ? 100 : 1;
}

function formatChartValue(value, percent = false, percentScale = 1) {
  if (!Number.isFinite(Number(value))) return "-";
  const displayValue = percent ? Number(value) * percentScale : Number(value);
  const rounded = formatCompactNumber(displayValue);
  return percent ? `${rounded}%` : rounded;
}

function formatCompactNumber(value) {
  const abs = Math.abs(Number(value));
  if (!Number.isFinite(abs)) return "-";
  if (abs === 0) return "0";
  if (Number.isInteger(Number(value))) return String(Number(value));
  const decimals = abs >= 100 ? 0
    : abs >= 10 ? 1
      : abs >= 0.1 ? 2
        : abs >= 0.01 ? 3
          : 4;
  return Number(value).toFixed(decimals).replace(/\.?0+$/, "");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function clampIndex(value, length) {
  const index = Number(value || 0);
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(index, Math.max(0, length - 1));
}

export const __test__ = {
  buildFluctuationVisualModel,
  buildChart,
  collectFluctuationAnomalies,
  chooseDisplayAnomalyIndex,
  getDisplayAnomalyIndex,
  isPercentMetric,
  resolvePercentDisplayScale,
  formatChartValue,
};

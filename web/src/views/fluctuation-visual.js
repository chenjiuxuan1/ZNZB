import { apiGet } from "../api.js";
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

export function renderFluctuationVisual(root) {
  const model = buildFluctuationVisualModel(state.batchHistory, state.countries?.countries || []);
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">波动图谱</h1>
        <p class="page-note">按国家展示最近一次巡检中的波动异常指标；点击图旁的点，查看该指标报异常前的正常走势与异常当天红点。</p>
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
}

async function reloadFluctuationHistory(root) {
  state.batchHistoryStatus = {
    type: "loading",
    title: "正在刷新波动图谱",
    detail: "正在读取最近的巡检历史，用于生成各国异常指标走势。",
  };
  renderFluctuationVisual(root);
  try {
    state.batchHistory = await apiGet("/api/batch-history?limit=50");
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
        <p class="muted">绿色表示异常前历史数据，红色表示报警当天的数据。历史记录未保存完整序列时，会用报警消息中的基准值生成参考基线。</p>
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
        <h2 class="panel-title">最近一次巡检没有波动异常</h2>
        <p class="success">没有可绘制的波动点。</p>
      </section>
    `;
  }

  return `
    <div class="fluctuation-country-grid">
      ${model.countries.map((country) => renderFluctuationCountry(country)).join("")}
    </div>
  `;
}

function renderFluctuationCountry(country) {
  const selectedIndex = clampIndex(state.fluctuationVisualSelected?.[country.countryCode], country.anomalies.length);
  const selected = country.anomalies[selectedIndex] || country.anomalies[0];
  const chart = buildChart(selected);
  return `
    <article class="panel fluctuation-country-card">
      <div class="fluctuation-country-head">
        <div>
          <h2 class="panel-title">${escapeHtml(country.countryName || country.countryCode || "-")}</h2>
          <p class="muted">${escapeHtml(country.countryCode || "-")} · ${escapeHtml(country.anomalies.length)} 个波动指标</p>
        </div>
        <span class="badge warn">${escapeHtml(country.anomalies.length)} 点</span>
      </div>
      <div class="fluctuation-visual-body">
        <div class="fluctuation-chart-wrap">
          ${renderLineChart(chart)}
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
    return `<div class="fluctuation-chart-empty">没有可绘制的数值</div>`;
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

  return `
    <svg class="fluctuation-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}">
      <rect x="0" y="0" width="${width}" height="${height}" rx="8"></rect>
      ${yTicks.map((tick) => {
        const y = pad.top + ((yMax - tick) / (yMax - yMin || 1)) * plotHeight;
        return `
          <line class="grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line>
          <text class="axis-label" x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(formatChartValue(tick, chart.percent))}</text>
        `;
      }).join("")}
      <path class="full-line" d="${fullPath}"></path>
      ${path ? `<path class="normal-line" d="${path}"></path>` : ""}
      ${coords.map((point) => `
        <circle class="${point.anomaly ? "anomaly-dot" : "normal-dot"}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.anomaly ? 5.8 : 3.8}">
          <title>${escapeHtml(point.label || "")} ${escapeHtml(formatChartValue(point.value, chart.percent))}</title>
        </circle>
      `).join("")}
      <text class="x-label" x="${pad.left}" y="${height - 10}">${escapeHtml(coords[0]?.label || "")}</text>
      <text class="x-label" x="${width - pad.right}" y="${height - 10}" text-anchor="end">${escapeHtml(anomalyPoint?.label || "")}</text>
    </svg>
  `;
}

function buildFluctuationVisualModel(history, countries = []) {
  const run = (history?.runs || []).find((item) => collectFluctuationAnomalies(item, countries).length) || (history?.runs || [])[0] || null;
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
    countries: countryModels,
    countryCount: countryModels.length,
    anomalyCount: anomalies.length,
  };
}

function collectFluctuationAnomalies(run, countries = []) {
  if (!run) return [];
  const countryNames = new Map((countries || []).map((country) => [String(country.code || country.countryCode || "").toUpperCase(), country.name || country.countryName || ""]));
  const rows = [];
  for (const countryRun of run.runs || []) {
    const countryCode = String(countryRun.countryCode || "").toUpperCase();
    const countryName = countryRun.countryName || countryNames.get(countryCode) || countryCode;
    for (const anomaly of countryRun.result?.anomalies || []) {
      const detail = parseAnomalyMessage(anomaly.message || "", anomaly.type || "");
      if (!isFluctuationAnomaly(anomaly, detail)) {
        continue;
      }
      rows.push({
        ...anomaly,
        countryCode,
        countryName,
        detail,
        metricLabel: buildMetricLabel(anomaly, detail),
      });
    }
  }
  return rows;
}

function isFluctuationAnomaly(anomaly, detail) {
  const type = String(anomaly?.type || "");
  const text = `${anomaly?.message || ""} ${detail?.reason || ""}`;
  if (["noData", "emptyMetrics", "queryError", "metabaseConfigError", "metabaseStalePublicLink", "notEmpty"].includes(type)) {
    return false;
  }
  return FLUCTUATION_TYPES.has(type) || /波动|变化|降为|到/.test(text);
}

function buildMetricLabel(anomaly, detail) {
  const parts = [
    detail.metricName,
    detail.dimensionText,
  ].filter(Boolean);
  return parts.join(" · ") || anomaly.column || anomaly.cardTitle || "未命名指标";
}

function buildChart(anomaly) {
  const realPoints = normalizeSeries(anomaly);
  const points = realPoints.length ? realPoints : synthesizeSeries(anomaly);
  const percent = points.some((point) => point.percent) || /%|百分点/.test(anomaly.message || "");
  return {
    title: anomaly.metricLabel,
    percent,
    points: points.map((point, index) => ({
      ...point,
      anomaly: point.anomaly || index === points.length - 1,
    })),
  };
}

function normalizeSeries(anomaly) {
  const candidate = anomaly.series || anomaly.history || anomaly.points || anomaly.evidence?.series || anomaly.fluctuation?.history;
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

function synthesizeSeries(anomaly) {
  const detail = anomaly.detail || parseAnomalyMessage(anomaly.message || "", anomaly.type || "");
  const baseline = parseNumericValue(detail.baselineValue);
  const current = parseNumericValue(detail.currentValue);
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) {
    return [];
  }
  const anomalyDate = extractAnomalyDate(detail.timeText) || extractIsoDate(anomaly.checkedAt || anomaly.statDate);
  const historyLength = 12;
  const points = [];
  for (let index = historyLength; index >= 1; index -= 1) {
    points.push({
      label: shiftDateLabel(anomalyDate, -index) || `D-${index}`,
      value: baseline,
      percent: /%/.test(detail.baselineValue || detail.currentValue || anomaly.message || ""),
      anomaly: false,
    });
  }
  points.push({
    label: anomalyDate || "异常当天",
    value: current,
    percent: /%/.test(detail.baselineValue || detail.currentValue || anomaly.message || ""),
    anomaly: true,
  });
  return points;
}

function parseNumericValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  const match = text.replace(/,/g, "").match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return NaN;
  return Number(match[0]);
}

function extractAnomalyDate(text) {
  const match = String(text || "").match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  return match?.[0] || "";
}

function extractIsoDate(value) {
  const match = String(value || "").match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  return match?.[0] || "";
}

function shiftDateLabel(dateText, offsetDays) {
  if (!dateText) return "";
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(5, 10);
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

function formatChartValue(value, percent = false) {
  if (!Number.isFinite(Number(value))) return "-";
  const rounded = Math.abs(value) >= 100 ? Number(value).toFixed(0) : Number(value).toFixed(1);
  return percent ? `${rounded}%` : rounded;
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
  collectFluctuationAnomalies,
  synthesizeSeries,
};

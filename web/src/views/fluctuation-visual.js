import { apiGet, apiPost, apiPut } from "../api.js";
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

const FLUCTUATION_SERIES_CONCURRENCY = 3;
const FLUCTUATION_SERIES_TIMEOUT_MS = 15_000;

export function renderFluctuationVisual(root) {
  const query = state.routeQuery || {};
  const requestedCountryCode = String(query.countryCode || "").toUpperCase();
  if (requestedCountryCode) state.fluctuationVisualCountryCode = requestedCountryCode;
  const model = buildFluctuationVisualModel(state.batchHistory, state.countries?.countries || [], {
    displayIndex: state.fluctuationVisualDisplayIndex,
    runId: query.runId,
    dashboardUrl: query.dashboardUrl,
    dashboardTitle: query.dashboardTitle,
  });
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
    ${state.fluctuationMetricTagError ? `<div class="sandbox-status error"><strong>标签保存失败</strong><span>${escapeHtml(state.fluctuationMetricTagError)}</span></div>` : ""}
    ${model.hiddenVerifiedNormalCount ? `<div class="sandbox-status success"><strong>已隐藏 ${escapeHtml(model.hiddenVerifiedNormalCount)} 个 AI 已排除/降级点</strong><span>AI 判定为无异常或业务变化的波动点不再展示在图谱中，原始告警、查询方式和完整结论仍保留在巡检历史详情中。</span></div>` : ""}
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
  root.querySelectorAll("[data-fluctuation-tag]").forEach((select) => {
    select.addEventListener("change", () => {
      void updateFluctuationMetricTag(root, select.dataset.tagKey || "", select.value);
    });
  });
  bindFluctuationChartTooltips(root);

  // History is intentionally user-triggered: this view must not slow app startup.
  const selectedCountry = getSelectedFluctuationCountry(model.countries || []);
  const requestedRunId = String(query.runId || "");
  const hasRequestedRun = !requestedRunId || (state.batchHistory?.runs || []).some((run) => run.id === requestedRunId);
  // A link opened from scan details needs its exact history run. App startup
  // normally provides it, but in-app navigation happens after startup and
  // therefore needs this fallback request.
  if (shouldLoadRequestedFluctuationRun({
    requestedRunId,
    hasRequestedRun,
    historyLoading: state.batchHistoryStatus?.type === "loading",
    alreadyRequestedRunId: state.fluctuationVisualRequestedRunId,
  })) {
    state.fluctuationVisualRequestedRunId = requestedRunId;
    void reloadFluctuationHistory(root);
  } else if (selectedCountry) {
    void hydrateVisibleFluctuationSeries(root, selectedCountry);
  }
  void loadFluctuationMetricTags(root, model);
}

async function reloadFluctuationHistory(root) {
  state.fluctuationVisualRefreshProgress = { stage: "history" };
  state.batchHistoryStatus = {
    type: "loading",
    title: "正在刷新波动图谱",
    detail: "正在读取最近的巡检历史，用于生成各国异常指标走势。",
  };
  renderFluctuationVisual(root);
  try {
    const requestedRunId = String(state.routeQuery?.runId || "");
    const historyUrl = requestedRunId
      ? `/api/batch-history?runId=${encodeURIComponent(requestedRunId)}`
      : "/api/batch-history?status=anomaly&limit=1";
    state.batchHistory = await apiGet(historyUrl);
    state.batchHistoryLoaded = true;
    const runId = state.batchHistory.runs?.[0]?.id;
    if (runId) {
      state.fluctuationVisualRefreshProgress = { stage: "display-index" };
      renderFluctuationVisual(root);
      const index = await apiGet(`/api/metabase-anomaly-analysis/display-index?runId=${encodeURIComponent(runId)}`);
      state.fluctuationVisualDisplayIndex = Object.fromEntries((index.items || []).map((item) => [
        `${runId}:${String(item.countryCode || "").toUpperCase()}:${item.anomalyIndex}`,
        item,
      ]));
    } else {
      state.fluctuationVisualDisplayIndex = {};
    }
    state.fluctuationVisualLoaded = true;
    state.fluctuationVisualRefreshProgress = null;
    state.batchHistoryStatus = null;
  } catch (error) {
    state.fluctuationVisualRequestedRunId = "";
    state.fluctuationVisualRefreshProgress = null;
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
  const refreshing = Boolean(state.fluctuationVisualRefreshProgress);
  return `
    <section class="panel fluctuation-toolbar">
      <div>
        <h2 class="panel-title">异常走势视图</h2>
        <p class="muted">绿色折线来自巡检时保存的真实查询结果，红色表示报警当天的数据。旧历史没有真实序列时不画参考线，避免误判。</p>
      </div>
      <button id="refresh-fluctuation-history" class="primary" type="button" ${refreshing ? "disabled aria-busy=\"true\"" : ""}>${refreshing ? "刷新中..." : (state.fluctuationVisualLoaded ? "刷新最新波动图谱" : "加载最新波动图谱")}</button>
    </section>
    ${renderFluctuationRefreshProgress()}
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
      <h2 class="panel-title">${state.fluctuationVisualLoaded ? "暂无巡检历史" : "波动图谱尚未加载"}</h2>
      <p class="muted">${state.fluctuationVisualLoaded ? "当前没有可绘制的巡检异常。" : "点击上方按钮读取最新一条异常巡检记录。"}</p>
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
      ${renderFluctuationCountryRows(selectedCountry)}
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

function renderFluctuationCountryRows(country) {
  const drawableCount = country.anomalies.filter(hasRealSeries).length;
  return `
    <article class="panel fluctuation-country-card">
      <div class="fluctuation-country-head">
        <div>
          <h2 class="panel-title">${escapeHtml(country.countryName || country.countryCode || "-")}</h2>
          <p class="muted">${escapeHtml(country.countryCode || "-")} · ${escapeHtml(country.anomalies.length)} 个波动指标${drawableCount < country.anomalies.length ? `，${escapeHtml(drawableCount)} 个已保存真实序列` : ""}</p>
        </div>
        <span class="badge warn">${escapeHtml(country.anomalies.length)} 点</span>
      </div>
      <div class="fluctuation-row-list">
        ${country.anomalies.map((anomaly, index) => renderFluctuationRow(anomaly, index)).join("")}
      </div>
    </article>
  `;
}

function renderFluctuationRow(anomaly, index) {
  const chart = buildChart(anomaly);
  const seriesState = state.fluctuationVisualSeries?.[anomaly.seriesKey];
  const tag = state.fluctuationMetricTags?.[anomaly.tagKey] || "二级";
  return `
    <section class="fluctuation-row">
      <div class="fluctuation-row-meta">
        <span class="fluctuation-row-index">${escapeHtml(index + 1)}</span>
        <div class="fluctuation-row-title">
          <h3>${escapeHtml(anomaly.metricLabel)}</h3>
          <p>${escapeHtml(anomaly.dashboardTitle || "-")}</p>
          <p>${escapeHtml(anomaly.cardTitle || "-")}</p>
        </div>
        <div class="fluctuation-row-detail">
          <div>${renderDetailField("当前值", anomaly.detail.currentValue || "-")}</div>
          <div>${renderDetailField("基准值", anomaly.detail.baselineValue || "-")}</div>
          ${renderOptionalDetailField("变化", anomaly.detail.changeValue)}
          <div>${renderDetailField("时间", anomaly.detail.timeText || "-")}</div>
        </div>
      </div>
      <div class="fluctuation-row-chart">
        ${renderFluctuationMetricTagControl(anomaly, tag)}
        ${renderLineChart(chart)}
        ${seriesState?.type === "loading" ? `<div class="fluctuation-chart-note">正在按看板 URL 拉取最近历史数据...</div>` : ""}
        ${seriesState?.type === "error" ? `<div class="fluctuation-chart-note error">${escapeHtml(seriesState.detail || "历史数据拉取失败")}</div>` : ""}
      </div>
    </section>
  `;
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
          ${renderOptionalDetailField("变化", selected.detail.changeValue)}
        <div>${renderDetailField("时间", selected.detail.timeText || "-")}</div>
      </div>
    </article>
  `;
}

function renderDetailField(label, value) {
  return `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
}

function shouldLoadRequestedFluctuationRun({
  requestedRunId = "",
  hasRequestedRun = false,
  historyLoading = false,
  alreadyRequestedRunId = "",
} = {}) {
  return Boolean(requestedRunId)
    && !hasRequestedRun
    && !historyLoading
    && alreadyRequestedRunId !== requestedRunId;
}

function renderFluctuationRefreshProgress() {
  const stage = state.fluctuationVisualRefreshProgress?.stage;
  if (!stage) return "";
  const historyActive = stage === "history";
  return `
    <section class="sub-panel schedule-progress-panel fluctuation-refresh-progress">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">正在更新波动图谱</h2><p class="muted">${historyActive ? "正在读取最新异常巡检历史" : "正在读取异常指标展示索引"}</p></div>
        <span class="badge warn">${historyActive ? "1/2" : "2/2"}</span>
      </div>
      <div class="progress-track" aria-label="波动图谱刷新进度"><span style="width:${historyActive ? 35 : 75}%"></span></div>
      <div class="schedule-stage-list">
        <article class="schedule-stage ${historyActive ? "running" : "success"}"><span class="schedule-stage-index">1</span><div><strong>读取巡检历史</strong><small>定位最新一条包含异常的巡检记录</small></div></article>
        <article class="schedule-stage ${historyActive ? "pending" : "running"}"><span class="schedule-stage-index">2</span><div><strong>构建图谱索引</strong><small>加载可展示异常指标的真实序列索引</small></div></article>
      </div>
    </section>
  `;
}

function renderOptionalDetailField(label, value) {
  const text = String(value ?? "").trim();
  return text && text !== "-" ? `<div>${renderDetailField(label, text)}</div>` : "";
}

function renderLineChart(chart) {
  if (chart.points.length < 2) {
    return `<div class="fluctuation-chart-empty">已读到这条异常，正在尝试按保存的看板 URL 回查最近历史数据；如果无法匹配，会在下方显示原因。</div>`;
  }
  const width = 640;
  const height = 340;
  const pad = { top: 28, right: 30, bottom: 42, left: 76 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const chartValues = chart.points
    .flatMap((point) => [point.value, point.baselineValue])
    .filter(Number.isFinite);
  const { yMin, yMax } = resolveChartYBounds(chartValues);

  const coords = chart.points.map((point, index) => {
    const x = pad.left + (chart.points.length === 1 ? plotWidth : (index / (chart.points.length - 1)) * plotWidth);
    const y = pad.top + ((yMax - point.value) / (yMax - yMin || 1)) * plotHeight;
    const baselineY = Number.isFinite(point.baselineValue)
      ? pad.top + ((yMax - point.baselineValue) / (yMax - yMin || 1)) * plotHeight
      : Number.NaN;
    return { ...point, x, y, baselineY };
  });
  const hasBaselineLine = coords.some((point) => Number.isFinite(point.baselineValue) && Number.isFinite(point.baselineY));
  const baselineCoords = coords.filter((point) => Number.isFinite(point.baselineValue) && Number.isFinite(point.baselineY));
  const normalCoords = coords.filter((point) => !point.anomaly);
  const anomalyPoint = coords.find((point) => point.anomaly) || coords[coords.length - 1];
  const path = buildSmoothPath(normalCoords);
  const fullPath = buildSmoothPath(coords);
  const baselinePath = buildSmoothPath(baselineCoords, "baselineY");
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
      ${hasBaselineLine ? `<path class="baseline-line" d="${baselinePath}"></path>` : `<path class="full-line" d="${fullPath}"></path>`}
      <path class="normal-line" d="${hasBaselineLine ? fullPath : path}"></path>
      ${hasBaselineLine ? baselineCoords.map((point) => `
        <circle class="baseline-dot" cx="${point.x.toFixed(1)}" cy="${point.baselineY.toFixed(1)}" r="3.2"></circle>
      `).join("") : ""}
      ${coords.map((point) => `
        <circle class="${point.anomaly ? "anomaly-dot" : "normal-dot"}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.anomaly ? 5.8 : 3.8}"></circle>
      `).join("")}
      ${hasBaselineLine ? baselineCoords.map((point) => renderChartHitTarget(point, chart, percentScale, {
        value: point.baselineValue,
        y: point.baselineY,
        label: "前14天同小时均值",
        comparisonValue: point.value,
        comparisonLabel: "与当天同小时对比",
      })).join("") : ""}
      ${coords.map((point, index) => renderChartHitTarget(point, chart, percentScale, {
        comparisonValue: hasBaselineLine ? point.baselineValue : coords[index - 1]?.value,
        comparisonLabel: hasBaselineLine ? "较前14天同小时均值" : "较前一天",
      })).join("")}
      ${hasBaselineLine ? `
        <g class="chart-legend" transform="translate(${pad.left}, 18)">
          <line class="normal-line" x1="0" y1="0" x2="20" y2="0"></line>
          <text x="26" y="4">当天24小时</text>
          <line class="baseline-line" x1="112" y1="0" x2="132" y2="0"></line>
          <text x="138" y="4">前14天同小时均值</text>
        </g>
      ` : ""}
      <text class="x-label" x="${pad.left}" y="${height - 10}">${escapeHtml(coords[0]?.label || "")}</text>
      <text class="x-label" x="${width - pad.right}" y="${height - 10}" text-anchor="end">${escapeHtml((hasBaselineLine ? coords.at(-1) : anomalyPoint)?.label || "")}</text>
    </svg>
  `;
}

function renderFluctuationMetricTagControl(anomaly, tag) {
  return `
    <label class="fluctuation-metric-tag">
      <span>标签</span>
      <select data-fluctuation-tag data-tag-key="${escapeHtml(anomaly.tagKey)}">
        ${["一级", "二级", "三级"].map((value) => `<option value="${value}"${tag === value ? " selected" : ""}>${value}</option>`).join("")}
      </select>
    </label>
  `;
}

async function loadFluctuationMetricTags(root, model) {
  const identities = (model.countries || []).flatMap((country) => country.anomalies || []).map((anomaly) => anomaly.tagIdentity).filter(Boolean);
  const requestKey = identities.map((identity) => identity.tagKey).sort().join("|");
  if (!requestKey || state.fluctuationMetricTagsRequestKey === requestKey) return;
  state.fluctuationMetricTagsRequestKey = requestKey;
  try {
    const payload = await apiPost("/api/fluctuation-metric-tags/lookup", { items: identities });
    state.fluctuationMetricTags = { ...(state.fluctuationMetricTags || {}), ...(payload.tags || {}) };
    state.fluctuationMetricTagIdentities = Object.fromEntries(identities.map((identity) => [identity.tagKey, identity]));
    state.fluctuationMetricTagError = "";
    renderFluctuationVisual(root);
  } catch (error) {
    state.fluctuationMetricTagError = error.message;
  }
}

async function updateFluctuationMetricTag(root, tagKey, tag) {
  const identity = state.fluctuationMetricTagIdentities?.[tagKey];
  if (!identity) return;
  const previous = state.fluctuationMetricTags?.[tagKey] || "二级";
  state.fluctuationMetricTags = { ...(state.fluctuationMetricTags || {}), [tagKey]: tag };
  renderFluctuationVisual(root);
  try {
    await apiPut("/api/fluctuation-metric-tags", { identity, tag });
    state.fluctuationMetricTagError = "";
  } catch (error) {
    state.fluctuationMetricTags = { ...(state.fluctuationMetricTags || {}), [tagKey]: previous };
    state.fluctuationMetricTagError = error.message;
    renderFluctuationVisual(root);
  }
}

function resolveChartYBounds(values = []) {
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const span = maxValue - minValue || Math.max(1, Math.abs(maxValue || 1));
  const paddedMin = minValue - span * 0.12;
  return {
    yMin: minValue >= 0 && paddedMin < 0 ? 0 : paddedMin,
    yMax: maxValue + span * 0.12,
  };
}

function buildSmoothPath(points = [], yKey = "y") {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${Number(points[0][yKey]).toFixed(1)}`;
  const tension = 0.18;
  let path = `M ${points[0].x.toFixed(1)} ${Number(points[0][yKey]).toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] || points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] || next;
    const currentY = Number(current[yKey]);
    const nextY = Number(next[yKey]);
    const control1X = current.x + (next.x - previous.x) * tension;
    const control1Y = currentY + (nextY - Number(previous[yKey])) * tension;
    const control2X = next.x - (after.x - current.x) * tension;
    const control2Y = nextY - (Number(after[yKey]) - currentY) * tension;
    path += ` C ${control1X.toFixed(1)} ${control1Y.toFixed(1)} ${control2X.toFixed(1)} ${control2Y.toFixed(1)} ${next.x.toFixed(1)} ${nextY.toFixed(1)}`;
  }
  return path;
}

function renderChartHitTarget(point, chart, percentScale, options = {}) {
  const value = Number(options.value ?? point.value);
  const comparisonValue = Number(options.comparisonValue);
  const comparison = Number.isFinite(comparisonValue)
    ? formatComparisonPercent(value, comparisonValue)
    : "-";
  const tooltip = [
    point.label || "-",
    `${options.label || "当前数据"}：${formatChartValue(value, chart.percent, percentScale)}`,
    `${options.comparisonLabel || "较前一天"}：${comparison}`,
  ].join("\n");
  const y = Number(options.y ?? point.y);
  return `<circle class="fluctuation-point-hit-area" cx="${point.x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" data-tooltip="${escapeHtml(tooltip)}" tabindex="0" role="img" aria-label="${escapeHtml(tooltip)}"></circle>`;
}

function formatComparisonPercent(value, referenceValue) {
  if (!Number.isFinite(value) || !Number.isFinite(referenceValue)) return "-";
  if (referenceValue === 0) return value === 0 ? "0.0%" : "基准为 0，无法计算";
  const change = ((value - referenceValue) / Math.abs(referenceValue)) * 100;
  return `${change >= 0 ? "+" : ""}${formatCompactNumber(change)}%`;
}

function bindFluctuationChartTooltips(root) {
  root.querySelector(".fluctuation-point-tooltip")?.remove();
  const tooltip = document.createElement("div");
  tooltip.className = "fluctuation-point-tooltip";
  tooltip.hidden = true;
  root.append(tooltip);
  const hideTooltip = () => {
    tooltip.hidden = true;
    tooltip.replaceChildren();
  };
  const moveTooltip = (event) => {
    const padding = 14;
    const maxX = window.innerWidth - tooltip.offsetWidth - padding;
    const maxY = window.innerHeight - tooltip.offsetHeight - padding;
    tooltip.style.left = `${Math.max(padding, Math.min(event.clientX + 14, maxX))}px`;
    tooltip.style.top = `${Math.max(padding, Math.min(event.clientY + 14, maxY))}px`;
  };
  const showTooltip = (event) => {
    const lines = String(event.currentTarget.dataset.tooltip || "").split("\n");
    tooltip.replaceChildren(...lines.map((line, index) => {
      const item = document.createElement(index === 0 ? "strong" : "span");
      item.textContent = line;
      return item;
    }));
    tooltip.hidden = false;
    moveTooltip(event);
  };
  root.querySelectorAll(".fluctuation-point-hit-area").forEach((point) => {
    point.addEventListener("pointerenter", showTooltip);
    point.addEventListener("pointermove", moveTooltip);
    point.addEventListener("pointerleave", hideTooltip);
    point.addEventListener("pointercancel", hideTooltip);
    point.addEventListener("focus", showTooltip);
    point.addEventListener("blur", hideTooltip);
  });
  root.querySelectorAll(".fluctuation-line-chart").forEach((chart) => {
    chart.addEventListener("pointerleave", hideTooltip);
    chart.addEventListener("pointermove", (event) => {
      if (!event.target.closest?.(".fluctuation-point-hit-area")) {
        hideTooltip();
      }
    });
  });
}

function buildFluctuationVisualModel(history, countries = [], options = {}) {
  const today = options.today || getBeijingDateKey(new Date());
  const todayRuns = (history?.runs || []).filter((item) => isRunUpdatedOnDate(item, today));
  const requestedRunId = String(options.runId || "");
  const requestedRun = (history?.runs || []).find((item) => item.id === requestedRunId);
  const run = requestedRun || todayRuns.find((item) => collectFluctuationAnomalies(item, countries).length) || todayRuns[0] || null;
  const allAnomalies = collectFluctuationAnomalies(run, countries)
    .filter((anomaly) => matchesDashboardFilter(anomaly, options));
  const displayIndex = options.displayIndex || {};
  const anomalies = allAnomalies.filter((anomaly) => !isAiSuppressedFluctuationPoint(displayIndex[`${anomaly.runId}:${anomaly.countryCode}:${anomaly.anomalyIndex}`]));
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
    hiddenVerifiedNormalCount: allAnomalies.length - anomalies.length,
  };
}

function isAiSuppressedFluctuationPoint(item = {}) {
  const verdict = String(item.dataSideVerdict || item.verdict || "").trim();
  const action = String(item.notificationAction || "").trim();
  return item.chartVisibility === "hide_verified_normal"
    || verdict === "verified_normal"
    || verdict === "business_change"
    || action === "downgrade";
}

function matchesDashboardFilter(anomaly, options = {}) {
  const dashboardUrl = String(options.dashboardUrl || "");
  const dashboardTitle = String(options.dashboardTitle || "");
  if (dashboardUrl) return String(anomaly.dashboardUrl || "") === dashboardUrl;
  return !dashboardTitle || String(anomaly.dashboardTitle || "") === dashboardTitle;
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
        tagIdentity: buildFluctuationMetricTagIdentity(anomaly, countryName, detail),
        tagKey: "",
      });
      rows[rows.length - 1].tagKey = rows[rows.length - 1].tagIdentity.tagKey;
    }
  }
  return rows;
}

function buildFluctuationMetricTagIdentity(anomaly = {}, countryName = "", detail = {}) {
  const identity = {
    country_name: normalizeTagText(countryName || anomaly.countryName || anomaly.countryCode || "未知国家"),
    dashboard_name: normalizeTagText(anomaly.dashboardTitle || "未命名看板"),
    card_name: normalizeTagText(anomaly.cardTitle || "未命名卡片"),
    metric_name: normalizeTagText(anomaly.metricName || anomaly.metricColumn || anomaly.column || anomaly.series?.find?.((point) => point?.metric)?.metric || detail.metricName || anomaly.cardTitle || "未命名指标"),
    dimension_name: normalizeTagDimension(detail.dimensionText),
    time_granularity: anomaly.series?.some?.((point) => point?.xType === "hour") || ["intradayTimePointChange", "intradaySameTimeChange"].includes(String(anomaly.type || "")) ? "hour" : "day",
    dashboard_url: normalizeTagText(anomaly.dashboardUrl || ""),
  };
  identity.tagKey = [identity.country_name, identity.dashboard_name, identity.card_name, identity.metric_name, identity.dimension_name, identity.time_granularity].join("\u001f");
  return identity;
}

function normalizeTagText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTagDimension(value) {
  const values = String(value || "").split(/[，,]/)
    .map(normalizeTagText)
    .filter((item) => item && !isTemporalTagDimension(item));
  return [...new Set(values)].sort().join("，") || "无维度";
}

function isTemporalTagDimension(value) {
  const name = normalizeTagText(String(value).split("=", 1)[0]).toLowerCase();
  return /日期|时间|小时|date|time|hour|stat_date|timezone/.test(name);
}

function isFluctuationAnomaly(anomaly, detail, countryCode = "") {
  const type = String(anomaly?.type || "");
  const text = `${anomaly?.message || ""} ${detail?.reason || ""}`;
  if (String(countryCode || "").toUpperCase() === "CN" && CHINA_SUPPRESSED_ANOMALY_TYPES.has(type)) {
    return false;
  }
  if (["noData", "emptyMetrics", "queryError", "metabaseConfigError", "metabaseStalePublicLink", "notEmpty", "requiredDatePresent", "intradayTimePointCompleteness", "staleLatestDate"].includes(type)) {
    return false;
  }
  if (/缺失|没有数据|无数据|no\s*data|empty/i.test(text)) return false;
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
  return normalizeSeries(anomaly).length >= 2;
}

function normalizeSeries(anomaly) {
  // Prefer the freshly queried dashboard series over a saved inspection snapshot.
  const candidate = anomaly.hydratedSeries || anomaly.series || anomaly.history || anomaly.points || anomaly.evidence?.series || anomaly.fluctuation?.history;
  const rawPoints = Array.isArray(candidate) ? candidate : [];
  const pointLimit = rawPoints.some((point) => point?.xType === "hour") ? 24 : 16;
  return rawPoints
    .map((point, index) => {
      const value = parseNumericValue(point.value ?? point.metric ?? point.y ?? point.currentValue);
      const baselineValue = parseNumericValue(point.baselineValue ?? point.baseline ?? point.average ?? point.avgValue);
      if (!Number.isFinite(value)) return null;
      const xType = point.xType || "date";
      return {
        label: String(xType === "hour"
          ? point.label || point.x || point.date || `H-${index}`
          : point.date || point.statDate || point.x || point.label || `D-${rawPoints.length - index - 1}`),
        value,
        ...(Number.isFinite(baselineValue) ? { baselineValue } : {}),
        baselineSampleCount: Number(point.baselineSampleCount || point.sampleCount || 0),
        percent: /%/.test(String(point.value ?? point.metric ?? "")),
        anomaly: Boolean(point.anomaly || point.isAnomaly || index === rawPoints.length - 1),
        xType,
      };
    })
    .filter(Boolean)
    .slice(-pointLimit);
}

function getSelectedModelAnomaly(model) {
  const country = getSelectedFluctuationCountry(model.countries || []);
  if (!country) return null;
  const selectedIndex = getDisplayAnomalyIndex(country);
  return country.anomalies[selectedIndex] || country.anomalies[0] || null;
}

async function hydrateVisibleFluctuationSeries(root, country) {
  const countryCode = country.countryCode || "";
  if (!countryCode) return;
  state.fluctuationVisualHydratingCountries = state.fluctuationVisualHydratingCountries || {};
  if (state.fluctuationVisualHydratingCountries[countryCode]) return;
  const pending = (country.anomalies || []).filter((anomaly) => {
    const current = state.fluctuationVisualSeries?.[anomaly.seriesKey];
    return !current || current.type === "idle";
  });
  if (!pending.length) return;
  state.fluctuationVisualHydratingCountries[countryCode] = true;
  try {
    const hydration = runWithConcurrency(
      pending,
      FLUCTUATION_SERIES_CONCURRENCY,
      (anomaly) => hydrateFluctuationSeries(root, anomaly, { renderLoading: false }),
    );
    renderFluctuationVisual(root);
    await hydration;
  } finally {
    state.fluctuationVisualHydratingCountries[countryCode] = false;
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function hydrateFluctuationSeries(root, anomaly, options = {}) {
  const key = anomaly.seriesKey || buildSeriesKey(anomaly.runId, anomaly.countryCode, anomaly.anomalyIndex, anomaly);
  const current = state.fluctuationVisualSeries?.[key];
  if (current?.type === "loading" || current?.type === "loaded" || current?.type === "error") {
    return;
  }
  state.fluctuationVisualSeries = {
    ...(state.fluctuationVisualSeries || {}),
    [key]: { type: "loading", series: [] },
  };
  if (options.renderLoading !== false) {
    renderFluctuationVisual(root);
  }
  try {
    const result = await apiPost("/api/fluctuation-visual/series", {
      anomaly,
      lookbackDays: 45,
      maxPoints: 15,
    }, { timeoutMs: FLUCTUATION_SERIES_TIMEOUT_MS });
    state.fluctuationVisualSeries = {
      ...(state.fluctuationVisualSeries || {}),
      [key]: {
        type: result.series?.length >= 2 ? "loaded" : "error",
        series: result.series || [],
        detail: result.message || `看板查询仅返回 ${result.series?.length || 0} 个可用点，无法绘制趋势。`,
      },
    };
  } catch (error) {
    const detail = /timed out/i.test(error.message || "")
      ? "查询超时（15秒），已跳过该看板，不影响其他图表加载。"
      : error.payload?.errors?.join("\n") || error.message;
    state.fluctuationVisualSeries = {
      ...(state.fluctuationVisualSeries || {}),
      [key]: {
        type: "error",
        series: [],
        detail,
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
  const values = (chart.points || [])
    .flatMap((point) => [point.value, point.baselineValue])
    .map((value) => Math.abs(Number(value)))
    .filter(Number.isFinite);
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
  normalizeSeries,
  runWithConcurrency,
  resolvePercentDisplayScale,
  formatChartValue,
  formatComparisonPercent,
  buildSmoothPath,
  resolveChartYBounds,
  renderOptionalDetailField,
  matchesDashboardFilter,
  shouldLoadRequestedFluctuationRun,
};

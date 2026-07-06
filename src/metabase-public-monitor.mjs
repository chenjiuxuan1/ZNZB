import path from "node:path";
import { collectDataQualityMetrics } from "./grafana-quality-monitor.mjs";
import { MetabasePublicClient } from "./metabase-public-client.mjs";
import { readJsonFile, writeJsonFile } from "./utils.mjs";

export async function checkPublicDashboards({
  dataQualityFn = collectDataQualityMetrics,
  inventory = null,
  inventoryFile,
  ruleConfig = null,
  outputFile,
  rulesFile,
  baselineCacheFile,
  queryCardFn = queryCard,
}) {
  const inventoryData = inventory || await readJsonFile(path.resolve(inventoryFile));
  const ruleConfigData = ruleConfig || await readJsonFile(path.resolve(rulesFile), {
    builtInChecks: { queryError: true, noData: true },
    rules: [],
  });
  const baselineCache = baselineCacheFile
    ? await readJsonFile(path.resolve(baselineCacheFile), { entries: [] })
    : { entries: [] };
  const baselineCacheEntries = new Map((baselineCache.entries || []).map((entry) => [entry.key, entry]));
  const baselineCacheUpdates = new Map();
  const anomalies = [];
  const checkedCards = [];
  const rules = ruleConfigData.rules || [];
  const shouldRunBuiltIns = ruleConfigData.builtInChecks?.queryError !== false || ruleConfigData.builtInChecks?.noData !== false;

  for (const dashboard of inventoryData.dashboards || []) {
    const client = new MetabasePublicClient({
      baseUrl: new URL(dashboard.url).origin,
      requestTimeoutSeconds: 30,
    });

    for (const card of dashboard.cards || []) {
      const matchingRules = rules.filter((rule) => ruleMatchesCard(rule, dashboard, card));
      if (!shouldRunBuiltIns && matchingRules.length === 0) {
        continue;
      }

      const defaultParameters = buildDefaultCardParameters(dashboard, card);
      for (const queryGroup of buildQueryGroups(matchingRules, shouldRunBuiltIns)) {
        const parameters = mergeParameters(defaultParameters, queryGroup.parameters);
        const cardResult = await queryCardFn(client, dashboard, card, parameters);
        checkedCards.push(summarizeCardResult(dashboard, card, cardResult, queryGroup.context));

        if (shouldRunBuiltIns) {
          anomalies.push(...evaluateBuiltIns(ruleConfigData, dashboard, card, cardResult));
        }

        anomalies.push(...evaluateRules(queryGroup.rules, dashboard, card, cardResult, {
          baselineCacheEntries,
          baselineCacheUpdates,
          context: queryGroup.context,
        }));
      }
    }
  }

  const dataQuality = ruleConfigData.dataQuality?.enabled
    ? await dataQualityFn({ config: ruleConfigData.dataQuality })
    : null;

  const result = {
    checkedAt: new Date().toISOString(),
    dashboardCount: inventoryData.dashboardCount,
    checkedCardCount: checkedCards.length,
    anomalyCount: anomalies.length,
    dataQualityAnomalyCount: countDataQualityIssues(dataQuality),
    anomalies,
    checkedCards,
    dataQuality,
  };

  if (outputFile) {
    await writeJsonFile(path.resolve(outputFile), result);
  }

  if (baselineCacheFile && baselineCacheUpdates.size > 0) {
    const mergedEntries = new Map(baselineCacheEntries);
    for (const [key, entry] of baselineCacheUpdates) {
      mergedEntries.set(key, entry);
    }

    const cutoffMs = Date.now() - 35 * 86_400_000;
    const entries = [...mergedEntries.values()].filter((entry) => {
      const timestampMs = Date.parse(entry.updatedAt || entry.baselineEndDate || "");
      return !Number.isFinite(timestampMs) || timestampMs >= cutoffMs;
    });

    await writeJsonFile(path.resolve(baselineCacheFile), {
      updatedAt: new Date().toISOString(),
      entries,
    });
  }

  return result;
}

function countDataQualityIssues(dataQuality) {
  return (dataQuality?.countries || []).reduce((sum, metric) => {
    if (metric.status === "ok") {
      const currentAnomalyCount = Number(metric.currentAnomalyCount || 0);
      return sum + (Number.isFinite(currentAnomalyCount) && currentAnomalyCount > 0 ? currentAnomalyCount : 0);
    }

    return sum + 1;
  }, 0);
}

export function evaluateRowsAgainstRule(rows, rule) {
  switch (rule.type) {
    case "rowCountOutsideRange":
      return checkRowCount(rows, rule);
    case "latestValueOutsideRange":
      return checkLatestValue(rows, rule);
    case "staleLatestDate":
      return checkStaleLatestDate(rows, rule);
    case "requiredDatePresent":
      return checkRequiredDatePresent(rows, rule);
    case "latestZeroRate":
      return checkLatestZeroRate(rows, rule);
    case "latestDayOverDayChange":
      return checkLatestDayOverDayChange(rows, rule);
    case "completeDayChange":
      return checkCompleteDayChange(rows, rule);
    case "intradayProgress":
      return checkIntradayProgress(rows, rule);
    case "intradaySameTimeChange":
      return checkIntradaySameTimeChange(rows, rule);
    case "intradayTimePointCompleteness":
      return checkIntradayTimePointCompleteness(rows, rule);
    case "intradayTimePointChange":
      return checkIntradayTimePointChange(rows, rule);
    case "notEmpty":
      return checkNotEmpty(rows, rule);
    default:
      return `Unsupported rule type: ${rule.type}`;
  }
}

function buildQueryGroups(rules, includeDefaultGroup) {
  const groups = new Map();

  if (includeDefaultGroup) {
    groups.set("[]", {
      parameters: [],
      context: null,
      rules: [],
    });
  }

  for (const rule of rules) {
    const parameters = rule.parameters || [];
    const key = JSON.stringify(parameters);
    if (!groups.has(key)) {
      groups.set(key, {
        parameters,
        context: rule.context || null,
        rules: [],
      });
    }
    groups.get(key).rules.push(rule);
  }

  return [...groups.values()].filter((group) => includeDefaultGroup || group.rules.length > 0);
}

export function buildDefaultCardParameters(dashboard, card) {
  const dashboardParameters = new Map((dashboard.parameters || []).map((parameter) => [parameter.id, parameter]));
  const parameters = [];

  for (const mapping of card.parameterMappings || []) {
    const parameter = dashboardParameters.get(mapping.parameter_id);
    if (!parameter || parameter.default === undefined || parameter.default === null || parameter.default === "") {
      continue;
    }

    parameters.push({
      id: parameter.id,
      type: parameter.type,
      target: mapping.target,
      value: parameter.default,
    });
  }

  return parameters;
}

export function mergeParameters(defaultParameters, overrideParameters) {
  const merged = new Map();
  const keyByTarget = new Map();

  for (const parameter of defaultParameters || []) {
    const key = parameterKey(parameter);
    merged.set(key, parameter);
    const targetKey = parameterTargetKey(parameter);
    if (targetKey) {
      keyByTarget.set(targetKey, key);
    }
  }

  for (const parameter of overrideParameters || []) {
    const targetKey = parameterTargetKey(parameter);
    const existingKey = targetKey ? keyByTarget.get(targetKey) : null;

    if (existingKey && merged.has(existingKey)) {
      const existingParameter = merged.get(existingKey);
      merged.set(existingKey, {
        ...existingParameter,
        ...parameter,
        id: existingParameter.id || parameter.id,
        type: parameter.type || existingParameter.type,
        target: parameter.target || existingParameter.target,
      });
      continue;
    }

    const key = parameterKey(parameter);
    merged.set(key, parameter);
    if (targetKey) {
      keyByTarget.set(targetKey, key);
    }
  }

  return [...merged.values()];
}

function parameterKey(parameter) {
  const targetKey = parameterTargetKey(parameter);
  if (targetKey) {
    return `target:${targetKey}`;
  }
  return `id:${parameter.id || ""}`;
}

function parameterTargetKey(parameter) {
  return parameter.target ? JSON.stringify(parameter.target) : "";
}

async function queryCard(client, dashboard, card, parameters = []) {
  try {
    const rows = await client.queryDashcardJson({
      cardId: card.cardId,
      dashboardUuid: dashboard.uuid,
      dashcardId: card.dashcardId,
      parameters,
    });
    return {
      ok: true,
      rows: Array.isArray(rows) ? rows : [],
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      error: error.message,
    };
  }
}

function summarizeCardResult(dashboard, card, result, context = null) {
  return {
    country: dashboard.country || null,
    countryCode: dashboard.countryCode || dashboard.country?.code,
    countryName: dashboard.countryName || dashboard.country?.name,
    dashboardTitle: dashboard.sourcePanelTitle || dashboard.title,
    cardTitle: card.title,
    context,
    rowCount: result.rows.length,
    ok: result.ok,
    error: result.error,
  };
}

function evaluateBuiltIns(config, dashboard, card, result) {
  const anomalies = [];
  const dashboardTitle = dashboard.sourcePanelTitle || dashboard.title;

  if (config.builtInChecks?.queryError !== false && !result.ok) {
    anomalies.push(
      buildAnomaly(
        dashboard,
        card,
        "queryError",
        `报表「${dashboardTitle}」的「${card.title}」查询失败：${result.error || "unknown error"}`,
      ),
    );
  }

  if (config.builtInChecks?.noData !== false && result.ok && result.rows.length === 0) {
    anomalies.push(buildAnomaly(dashboard, card, "noData", `报表「${dashboardTitle}」的「${card.title}」没有值`));
  }

  if (dashboardTitle && card.title) {
    return anomalies;
  }

  return anomalies;
}

function evaluateRules(rules, dashboard, card, result, options = {}) {
  if (!result.ok) {
    return [];
  }

  return rules
    .filter((rule) => ruleMatchesCard(rule, dashboard, card))
    .flatMap((rule) => {
      const effectiveRule = applyDashboardRuleDefaults(rule, dashboard);
      effectiveRule.baselineCacheEntries = options.baselineCacheEntries;
      effectiveRule.baselineCacheUpdates = options.baselineCacheUpdates;
      effectiveRule.baselineScope = {
        countryCode: dashboard.countryCode || dashboard.country?.code || "",
        countryName: dashboard.countryName || dashboard.country?.name || "",
        dashboardTitle: dashboard.sourcePanelTitle || dashboard.title || "",
        cardTitle: card.title || "",
        context: options.context || effectiveRule.context || "",
      };
      const messages = normalizeMessages(evaluateRowsAgainstRule(result.rows, effectiveRule));
      return messages.map((message) =>
        buildAnomaly(
          dashboard,
          card,
          effectiveRule.type,
          formatRuleMessage(message, dashboard, card, effectiveRule),
          effectiveRule.context,
        ),
      );
    })
    .filter(Boolean);
}

function applyDashboardRuleDefaults(rule, dashboard) {
  const timezone = rule.timezone === "dashboard" || !rule.timezone
    ? dashboard.timezone || dashboard.country?.timezone || "Asia/Jakarta"
    : rule.timezone;

  return {
    ...rule,
    timezone,
  };
}

function formatRuleMessage(message, dashboard, card, rule = {}) {
  const dashboardTitle = dashboard.sourcePanelTitle || dashboard.title;
  const countryCode = dashboard.countryCode || dashboard.country?.code || "";
  const countryName = dashboard.countryName || dashboard.country?.name || "";
  const formatted = String(message)
    .replaceAll("{dashboardTitle}", dashboardTitle || "")
    .replaceAll("{countryCode}", countryCode)
    .replaceAll("{countryName}", countryName)
    .replaceAll("{cardTitle}", card.title || "");

  return rule.context ? `${rule.context}：${formatted}` : formatted;
}

function ruleMatchesCard(rule, dashboard, card) {
  if ((rule.exclude || []).some((excludeRule) => ruleMatchesCard(excludeRule, dashboard, card))) {
    return false;
  }

  const dashboardTitle = dashboard.sourcePanelTitle || dashboard.title;
  const countryCode = dashboard.countryCode || dashboard.country?.code;
  const countryName = dashboard.countryName || dashboard.country?.name;

  if (!matchesTextSelector(dashboardTitle, {
    value: rule.dashboardTitle,
    values: rule.dashboardTitles,
    pattern: rule.dashboardTitlePattern,
  })) {
    return false;
  }

  if (!matchesTextSelector(countryCode, {
    value: rule.countryCode,
    values: rule.countryCodes,
    pattern: rule.countryCodePattern,
  })) {
    return false;
  }

  if (!matchesTextSelector(countryName, {
    value: rule.countryName,
    values: rule.countryNames,
    pattern: rule.countryNamePattern,
  })) {
    return false;
  }

  if (!matchesTextSelector(card.title, {
    value: rule.cardTitle,
    values: rule.cardTitles,
    pattern: rule.cardTitlePattern,
  })) {
    return false;
  }

  if (rule.cardId !== undefined && Number(rule.cardId) !== Number(card.cardId)) {
    return false;
  }

  if (rule.cardIds && !rule.cardIds.map(Number).includes(Number(card.cardId))) {
    return false;
  }

  return true;
}

function matchesTextSelector(text, selector) {
  if (selector.value !== undefined && selector.value !== text) {
    return false;
  }

  if (selector.values && !selector.values.includes(text)) {
    return false;
  }

  if (selector.pattern && !new RegExp(selector.pattern).test(text || "")) {
    return false;
  }

  return true;
}

function checkRowCount(rows, rule) {
  if (rule.min !== undefined && rows.length < rule.min) {
    return `row count ${rows.length} is below ${rule.min}`;
  }

  if (rule.max !== undefined && rows.length > rule.max) {
    return `row count ${rows.length} is above ${rule.max}`;
  }

  return null;
}

function checkNotEmpty(rows, rule) {
  if (rows.length > 0) {
    return null;
  }

  return rule.message || "没有值";
}

function checkLatestValue(rows, rule) {
  const row = pickLatestRow(rows, rule.dateColumn);
  if (!row) {
    return "no row available for latest value check";
  }

  const value = Number(row[rule.column]);
  if (!Number.isFinite(value)) {
    return `column ${rule.column} is not numeric in latest row`;
  }

  if (rule.min !== undefined && value < rule.min) {
    return `${rule.column} latest value ${value} is below ${rule.min}`;
  }

  if (rule.max !== undefined && value > rule.max) {
    return `${rule.column} latest value ${value} is above ${rule.max}`;
  }

  return null;
}

function checkStaleLatestDate(rows, rule) {
  const row = pickLatestRow(rows, rule.dateColumn);
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  const latestTime = row ? Date.parse(row[dateColumn]) : Number.NaN;

  if (!Number.isFinite(latestTime)) {
    return "no parseable latest date found";
  }

  const ageDays = (Date.now() - latestTime) / 86_400_000;
  if (ageDays > rule.maxAgeDays) {
    return `${dateColumn} latest date ${row[dateColumn]} is ${ageDays.toFixed(1)} days old`;
  }

  return null;
}

function checkRequiredDatePresent(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  const timezone = rule.timezone || "Asia/Jakarta";
  const now = resolveNow(rule);
  const requiredLagDays = rule.requiredLagDays ?? 0;
  const requiredDate = rule.requiredDate || addDays(getZonedDateKey(now, timezone), -requiredLagDays);
  const expectedLabel = requiredLagDays === 0 ? "D0" : `D-${requiredLagDays}`;

  if (!rows.length) {
    return `数据新鲜度异常：没有数据，无法确认 ${expectedLabel} ${requiredDate}`;
  }

  if (!dateColumn) {
    return `数据新鲜度异常：没有可识别的日期列，无法确认 ${expectedLabel} ${requiredDate}`;
  }

  const dates = [...new Set(rows.map((row) => normalizeDateKey(row[dateColumn])).filter(Boolean))].sort();
  if (dates.includes(requiredDate)) {
    return null;
  }

  const latestDate = dates[dates.length - 1] || "无";
  return `数据新鲜度异常：${dateColumn} 缺少 ${expectedLabel} ${requiredDate} 的数据，当前最新日期是 ${latestDate}`;
}

function checkLatestZeroRate(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  const numericColumns = selectNumericColumns(rows, rule, {
    defaultPattern: "率|~",
  });
  const series = buildLatestSeries(rows, dateColumn, numericColumns, rule.dimensionColumns);
  const messages = [];

  for (const item of series) {
    for (const column of numericColumns) {
      const value = toNumber(item.latest[column]);
      if (value === 0) {
        messages.push(`指标「${column}」最新值为 0${formatSeriesSuffix(item, dateColumn)}`);
      }
    }
  }

  return limitMessages(messages, rule);
}

function checkLatestDayOverDayChange(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  const numericColumns = selectNumericColumns(rows, rule);
  const series = buildLatestSeries(rows, dateColumn, numericColumns, rule.dimensionColumns);
  const maxAbsChangeRate = rule.maxAbsChangeRate ?? 0.1;
  const messages = [];

  for (const item of series) {
    if (!item.previous) {
      continue;
    }

    for (const column of numericColumns) {
      const latest = toNumber(item.latest[column]);
      const previous = toNumber(item.previous[column]);

      if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous === 0) {
        continue;
      }

      const changeRate = (latest - previous) / Math.abs(previous);
      if (Math.abs(changeRate) > maxAbsChangeRate) {
        messages.push({
          absChangeRate: Math.abs(changeRate),
          message:
            `指标「${column}」最新值 ${formatNumber(latest)} 较上一日 ${formatNumber(previous)} ` +
            `波动 ${formatPercent(changeRate)}${formatComparisonSuffix(item, dateColumn)}`,
        });
      }
    }
  }

  return limitMessages(
    messages
      .sort((left, right) => right.absChangeRate - left.absChangeRate)
      .map((item) => item.message),
    rule,
  );
}

function checkCompleteDayChange(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  if (!dateColumn) {
    return "no parseable date column found";
  }

  const numericColumns = selectNumericColumns(rows, rule);
  const timezone = rule.timezone || "Asia/Jakarta";
  const now = resolveNow(rule);
  const latestAllowedDate = rule.completeDate || addDays(getZonedDateKey(now, timezone), -(rule.completeLagDays ?? 1));
  const series = buildDailySeries(rows, dateColumn, numericColumns, rule.dimensionColumns, rule.ignoreDimensionColumns);
  const lookbackAnchorDate = resolveLookbackAnchorDate(series, latestAllowedDate);
  const lookbackStartDate =
    lookbackAnchorDate && rule.lookbackDays !== null ? addDays(lookbackAnchorDate, -(rule.lookbackDays ?? 7)) : null;
  const messages = [];

  for (const item of series) {
    const dates = [...item.rowsByDate.keys()]
      .filter((date) => date <= latestAllowedDate)
      .filter((date) => !lookbackStartDate || date >= lookbackStartDate)
      .sort();
    if (dates.length < 2) {
      continue;
    }

    const currentDate = dates[dates.length - 1];
    const previousDate = dates[dates.length - 2];
    const dateGapDays = getDateGapDays(previousDate, currentDate);
    if (rule.maxDateGapDays !== undefined && dateGapDays > rule.maxDateGapDays) {
      continue;
    }

    const currentRow = item.rowsByDate.get(currentDate);
    const previousRow = item.rowsByDate.get(previousDate);
    const columnChanges = [];

    for (const column of numericColumns) {
      const current = toNumber(currentRow[column]);
      const previous = toNumber(previousRow[column]);
      if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
        continue;
      }

      if (rule.minPrevious !== undefined && Math.abs(previous) < rule.minPrevious) {
        continue;
      }

      const changeRate = (current - previous) / Math.abs(previous);
      const absDelta = Math.abs(current - previous);
      if (shouldSuppressSmallNumericChange(column, current, previous, rule)) {
        continue;
      }

      columnChanges.push({
        column,
        current,
        previous,
        changeRate,
        absDelta,
        outsideRule: isChangeOutsideRule(changeRate, absDelta, rule),
      });
    }

    for (const change of columnChanges) {
      if (!change.outsideRule || shouldSuppressCorrelatedChange(change, columnChanges, rule)) {
        continue;
      }

      messages.push({
        absChangeRate: Math.abs(change.changeRate),
        message:
          `完整日指标「${change.column}」从 ${formatMetricValue(change.previous, rule)} 到 ${formatMetricValue(change.current, rule)}，` +
          `${formatChangeDescription(change.changeRate, change.current - change.previous, rule)}${formatDateComparisonSuffix(
            item,
            dateColumn,
            currentDate,
            previousDate,
          )}`,
      });
    }
  }

  return limitMessages(
    messages
      .sort((left, right) => right.absChangeRate - left.absChangeRate)
      .map((item) => item.message),
    rule,
  );
}

function checkIntradayProgress(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  if (!dateColumn) {
    return "no parseable date column found";
  }

  const numericColumns = selectNumericColumns(rows, rule);
  const timezone = rule.timezone || "Asia/Jakarta";
  const now = resolveNow(rule);
  const localNow = getZonedNow(now, timezone);
  const currentDate = rule.currentDate || localNow.dateKey;
  const previousDate = rule.previousDate || addDays(currentDate, -1);
  const expectedProgress = resolveExpectedProgress(rule.expectedProgress, localNow.hour + localNow.minute / 60);
  const maxBelowExpectedRate = rule.maxBelowExpectedRate ?? 0.3;
  const maxAboveExpectedRate = rule.maxAboveExpectedRate;
  const minPrevious = rule.minPrevious ?? 1;
  const series = buildDailySeries(rows, dateColumn, numericColumns, rule.dimensionColumns, rule.ignoreDimensionColumns);
  const messages = [];

  for (const item of series) {
    const currentRow = item.rowsByDate.get(currentDate);
    const previousRow = item.rowsByDate.get(previousDate);

    if (!previousRow) {
      continue;
    }

    if (!currentRow) {
      if (rule.alertWhenTodayMissing) {
        messages.push(`当日进度缺失：${currentDate} 没有数据${formatDimensionSuffix(item)}`);
      }
      continue;
    }

    for (const column of numericColumns) {
      const current = toNumber(currentRow[column]);
      const previous = toNumber(previousRow[column]);
      if (!Number.isFinite(current) || !Number.isFinite(previous) || previous < minPrevious) {
        continue;
      }

      const actualProgress = current / previous;
      const lowerBound = expectedProgress * (1 - maxBelowExpectedRate);
      const upperBound =
        maxAboveExpectedRate === undefined ? Number.POSITIVE_INFINITY : expectedProgress * (1 + maxAboveExpectedRate);

      if (actualProgress < lowerBound || actualProgress > upperBound) {
        const direction = actualProgress < lowerBound ? "低于" : "高于";
        messages.push({
          distance: Math.abs(actualProgress - expectedProgress),
          message:
            `当日指标「${column}」进度 ${formatPercent(actualProgress)} ${direction}期望 ${formatPercent(
              expectedProgress,
            )}` +
            `（${timezone} ${localNow.timeLabel}，${currentDate}=${formatNumber(current)}，` +
            `${previousDate}=${formatNumber(previous)}${formatDimensionText(item)}）`,
        });
      }
    }
  }

  return limitMessages(
    messages
      .sort((left, right) => right.distance - left.distance)
      .map((item) => item.message),
    rule,
  );
}

function checkIntradaySameTimeChange(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  if (!dateColumn) {
    return "no parseable date column found";
  }

  const timeColumn = rule.timeColumn || "开始时间";
  const numericColumns = selectNumericColumns(rows, rule);
  const timezone = rule.timezone || "Asia/Jakarta";
  const now = resolveNow(rule);
  const localNow = getZonedNow(now, timezone);
  const currentDate = rule.currentDate || localNow.dateKey;
  const previousDate = rule.previousDate || addDays(currentDate, -1);
  const currentTime = localNow.hour + localNow.minute / 60;
  const maxAbsChangeRate = rule.maxAbsChangeRate ?? 0.2;
  const minPrevious = rule.minPrevious ?? 1;
  const series = buildIntradaySeries(
    rows,
    dateColumn,
    timeColumn,
    numericColumns,
    rule.dimensionColumns,
    rule.ignoreDimensionColumns,
  );
  const messages = [];

  for (const item of series) {
    const currentRows = item.rowsByDate.get(currentDate) || [];
    const currentCutoff = rule.cutoffTime
      ? parseScheduleHour(rule.cutoffTime)
      : resolveLatestTimeAtOrBefore(currentRows, timeColumn, currentTime);

    if (!Number.isFinite(currentCutoff)) {
      if (rule.alertWhenTodayMissing) {
        messages.push(`同时间进度缺失：${currentDate} 没有可用的 ${timeColumn} 数据${formatDimensionSuffix(item)}`);
      }
      continue;
    }

    const previousRows = item.rowsByDate.get(previousDate) || [];
    const currentValues = sumRowsUntilTime(currentRows, timeColumn, numericColumns, currentCutoff);
    const previousValues = sumRowsUntilTime(previousRows, timeColumn, numericColumns, currentCutoff);
    const cutoffLabel = formatHourLabel(currentCutoff);

    for (const column of numericColumns) {
      const current = currentValues[column];
      const previous = previousValues[column];
      if (!Number.isFinite(current) || !Number.isFinite(previous) || Math.abs(previous) < minPrevious) {
        continue;
      }

      const changeRate = (current - previous) / Math.abs(previous);
      if (Math.abs(changeRate) > maxAbsChangeRate) {
        messages.push({
          absChangeRate: Math.abs(changeRate),
          message:
            `同时间指标「${column}」从 ${formatNumber(previous)} 到 ${formatNumber(current)}，波动 ${formatSignedPercent(
              changeRate,
            )}` +
            `（${timezone} 截止 ${cutoffLabel}，${dateColumn} ${currentDate} 对比 ${previousDate}${formatDimensionText(
              item,
            )}）`,
        });
      }
    }
  }

  return limitMessages(
    messages
      .sort((left, right) => right.absChangeRate - left.absChangeRate)
      .map((item) => item.message),
    rule,
  );
}

function checkIntradayTimePointCompleteness(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  if (!dateColumn) {
    return "no parseable date column found";
  }

  const timeColumn = rule.timeColumn || "开始时间";
  const numericColumns = selectNumericColumns(rows, rule);
  const timezone = rule.timezone || "Asia/Jakarta";
  const now = resolveNow(rule);
  const localNow = getZonedNow(now, timezone);
  const currentDate = rule.currentDate || localNow.dateKey;
  const previousDate = rule.previousDate || addDays(currentDate, -(rule.previousLagDays ?? 1));
  const fixedExpectedTimes = buildExpectedTimePointMinutes(rule, localNow);
  const series = buildIntradaySeries(
    rows,
    dateColumn,
    timeColumn,
    numericColumns,
    rule.dimensionColumns,
    rule.ignoreDimensionColumns,
  );
  const messages = [];

  for (const item of series) {
    const currentRows = item.rowsByDate.get(currentDate) || [];
    const previousRows = item.rowsByDate.get(previousDate) || [];
    const expectedTimes = resolveCompletenessExpectedTimes(rule, fixedExpectedTimes, previousRows, timeColumn);
    if (!expectedTimes.length) {
      continue;
    }

    const actualTimes = new Set(
      currentRows
        .map((row) => parseScheduleMinutes(row[timeColumn]))
        .filter((time) => Number.isFinite(time) && time <= expectedTimes.at(-1)),
    );
    const missingTimes = expectedTimes.filter((time) => !actualTimes.has(time));
    if (missingTimes.length) {
      messages.push(
        `半小时点数据缺失：${dateColumn} ${currentDate} 缺少 ${formatTimePointList(missingTimes)}` +
          `（${timezone} ${localNow.timeLabel}，${formatCompletenessExpectation(
            rule,
            expectedTimes,
            previousDate,
          )}${formatDimensionText(item)}）`,
      );
    }
  }

  return limitMessages(messages, rule);
}

function checkIntradayTimePointChange(rows, rule) {
  const dateColumn = rule.dateColumn || inferDateColumn(rows);
  if (!dateColumn) {
    return "no parseable date column found";
  }

  const timeColumn = rule.timeColumn || "开始时间";
  const numericColumns = selectNumericColumns(rows, rule);
  const timezone = rule.timezone || "Asia/Jakarta";
  const now = resolveNow(rule);
  const localNow = getZonedNow(now, timezone);
  const currentDate = rule.currentDate || localNow.dateKey;
  const previousDate = rule.previousDate || addDays(currentDate, -(rule.previousLagDays ?? 1));
  const expectedTimes = buildExpectedTimePointMinutes(rule, localNow);
  const maxAbsChangeRate = rule.maxAbsChangeRate ?? 0.15;
  const baselineMaxAbsChangeRate = rule.baselineMaxAbsChangeRate ?? maxAbsChangeRate;
  const baselineLookbackDays = rule.baselineLookbackDays ?? 30;
  const baselineMinSamples = rule.baselineMinSamples ?? 7;
  const minPrevious = rule.minPrevious ?? 1;
  const series = buildIntradaySeries(
    rows,
    dateColumn,
    timeColumn,
    numericColumns,
    rule.dimensionColumns,
    rule.ignoreDimensionColumns,
  );
  const messages = [];

  for (const item of series) {
    const currentRows = item.rowsByDate.get(currentDate) || [];
    const previousRows = item.rowsByDate.get(previousDate) || [];
    for (const time of expectedTimes) {
      const currentValues = sumRowsAtTime(currentRows, timeColumn, numericColumns, time);
      const previousValues = sumRowsAtTime(previousRows, timeColumn, numericColumns, time);
      if (!currentValues || !previousValues) {
        continue;
      }

      for (const column of numericColumns) {
        const current = currentValues[column];
        const previous = previousValues[column];
        if (!Number.isFinite(current) || !Number.isFinite(previous) || Math.abs(previous) < minPrevious) {
          continue;
        }

        const changeRate = (current - previous) / Math.abs(previous);
        if (Math.abs(changeRate) > maxAbsChangeRate) {
          const baseline = resolveTimePointBaseline({
            item,
            column,
            time,
            timeColumn,
            currentDate,
            previousDate,
            lookbackDays: baselineLookbackDays,
            minSamples: baselineMinSamples,
            rule,
          });
          const hasBaseline = baseline && Number.isFinite(baseline.median) && baseline.sampleCount >= baselineMinSamples;
          const baselineChangeRate = hasBaseline && Math.abs(baseline.median) >= minPrevious
            ? (current - baseline.median) / Math.abs(baseline.median)
            : Number.NaN;
          if (hasBaseline && Number.isFinite(baselineChangeRate) && Math.abs(baselineChangeRate) <= baselineMaxAbsChangeRate) {
            continue;
          }

          const baselineText = hasBaseline && Number.isFinite(baselineChangeRate)
            ? `；近${baseline.lookbackDays}天同点中位数 ${formatNumber(baseline.median)}（样本${baseline.sampleCount}天），较基线 ${formatSignedPercent(baselineChangeRate)}`
            : "";
          messages.push({
            absChangeRate: Math.max(Math.abs(changeRate), Number.isFinite(baselineChangeRate) ? Math.abs(baselineChangeRate) : 0),
            message:
              `同时间点指标「${column}」从 ${formatNumber(previous)} 到 ${formatNumber(current)}，波动 ${formatSignedPercent(
                changeRate,
              )}${baselineText}` +
              `（${timezone} ${formatHourLabel(time / 60)}，${dateColumn} ${currentDate} 对比 ${previousDate}${formatDimensionText(
                item,
              )}）`,
          });
        }
      }
    }
  }

  return limitMessages(
    messages
      .sort((left, right) => right.absChangeRate - left.absChangeRate)
      .map((item) => item.message),
    rule,
  );
}

function resolveTimePointBaseline({ item, column, time, timeColumn, currentDate, previousDate, lookbackDays, minSamples, rule }) {
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
    return null;
  }

  const baselineEndDate = addDays(currentDate, -1);
  const baselineStartDate = addDays(currentDate, -lookbackDays);
  const key = buildBaselineCacheKey({
    rule,
    item,
    column,
    time,
    currentDate,
    baselineStartDate,
    baselineEndDate,
  });
  const cached = rule.baselineCacheEntries?.get(key);
  if (cached && Number(cached.sampleCount || 0) >= minSamples && Number.isFinite(Number(cached.median))) {
    return {
      ...cached,
      median: Number(cached.median),
      sampleCount: Number(cached.sampleCount),
      lookbackDays: Number(cached.lookbackDays || lookbackDays),
    };
  }

  const samples = [];
  for (const [dateKey, rows] of item.rowsByDate.entries()) {
    if (dateKey < baselineStartDate || dateKey > baselineEndDate || dateKey === currentDate) {
      continue;
    }
    if (rule.excludePreviousFromBaseline === true && dateKey === previousDate) {
      continue;
    }

    const values = sumRowsAtTime(rows, timeColumn, [column], time);
    const value = values ? values[column] : Number.NaN;
    if (Number.isFinite(value)) {
      samples.push(value);
    }
  }

  if (samples.length === 0) {
    return null;
  }

  const baseline = {
    key,
    countryCode: rule.baselineScope?.countryCode || "",
    countryName: rule.baselineScope?.countryName || "",
    dashboardTitle: rule.baselineScope?.dashboardTitle || "",
    cardTitle: rule.baselineScope?.cardTitle || "",
    context: rule.baselineScope?.context || "",
    column,
    timeMinutes: time,
    timeLabel: formatHourLabel(time / 60),
    dimensionValues: item.dimensionValues || {},
    currentDate,
    baselineStartDate,
    baselineEndDate,
    lookbackDays,
    sampleCount: samples.length,
    median: median(samples),
    updatedAt: new Date().toISOString(),
  };

  rule.baselineCacheUpdates?.set(key, baseline);
  return baseline;
}

function buildBaselineCacheKey({ rule, item, column, time, currentDate, baselineStartDate, baselineEndDate }) {
  return JSON.stringify({
    countryCode: rule.baselineScope?.countryCode || "",
    dashboardTitle: rule.baselineScope?.dashboardTitle || "",
    cardTitle: rule.baselineScope?.cardTitle || "",
    context: rule.baselineScope?.context || "",
    dateColumn: rule.dateColumn || "",
    timeColumn: rule.timeColumn || "",
    column,
    time,
    currentDate,
    baselineStartDate,
    baselineEndDate,
    dimensions: item.dimensionValues || {},
  });
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return Number.NaN;
  }

  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pickLatestRow(rows, explicitDateColumn) {
  if (!rows.length) {
    return null;
  }

  const dateColumn = explicitDateColumn || inferDateColumn(rows);
  if (!dateColumn) {
    return rows[rows.length - 1];
  }

  return [...rows].sort((left, right) => {
    return Date.parse(right[dateColumn]) - Date.parse(left[dateColumn]);
  })[0];
}

function inferDateColumn(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const candidateColumns = columns.filter((column) => rows.some((row) => isDateLikeValue(row[column])));
  return candidateColumns.find((column) => isDateColumnName(column)) || candidateColumns[0];
}

function isDateColumnName(column) {
  return /(日期|时间|date|day|dt|time)/i.test(column);
}

function isDateLikeValue(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(normalized)) {
    return false;
  }

  return Number.isFinite(Date.parse(normalized));
}

function selectNumericColumns(rows, rule, options = {}) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const pattern = rule.columnPattern || options.defaultPattern;
  const matcher = pattern ? new RegExp(pattern) : null;
  const explicitColumns = rule.columns || (rule.column ? [rule.column] : null);

  return columns.filter((column) => {
    if (explicitColumns && !explicitColumns.includes(column)) {
      return false;
    }

    if (matcher && !matcher.test(column)) {
      return false;
    }

    return rows.some((row) => Number.isFinite(toNumber(row[column])));
  });
}

function buildLatestSeries(rows, dateColumn, numericColumns, explicitDimensionColumns) {
  if (!rows.length) {
    return [];
  }

  const dimensionColumns = explicitDimensionColumns || inferDimensionColumns(rows, dateColumn, numericColumns);
  const groups = new Map();

  for (const row of rows) {
    const key = JSON.stringify(dimensionColumns.map((column) => row[column] ?? ""));
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  return [...groups.values()]
    .map((groupRows) => {
      const sortedRows = sortRowsByDate(groupRows, dateColumn);
      return {
        dimensionColumns,
        latest: sortedRows[sortedRows.length - 1],
        previous: sortedRows[sortedRows.length - 2] || null,
      };
    })
    .filter((item) => item.latest);
}

function buildDailySeries(rows, dateColumn, numericColumns, explicitDimensionColumns, ignoredDimensionColumns = []) {
  if (!rows.length) {
    return [];
  }

  const dimensionColumns =
    explicitDimensionColumns || inferDimensionColumns(rows, dateColumn, numericColumns, ignoredDimensionColumns);
  const groups = new Map();

  for (const row of rows) {
    const dateKey = normalizeDateKey(row[dateColumn]);
    if (!dateKey) {
      continue;
    }

    const groupKey = JSON.stringify(dimensionColumns.map((column) => row[column] ?? ""));
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        dimensionColumns,
        dimensionValues: Object.fromEntries(dimensionColumns.map((column) => [column, row[column]])),
        rowsByDate: new Map(),
      });
    }

    const group = groups.get(groupKey);
    if (!group.rowsByDate.has(dateKey)) {
      group.rowsByDate.set(dateKey, {
        [dateColumn]: dateKey,
        ...group.dimensionValues,
      });
    }

    const dailyRow = group.rowsByDate.get(dateKey);
    for (const column of numericColumns) {
      const value = toNumber(row[column]);
      if (Number.isFinite(value)) {
        dailyRow[column] = (toNumber(dailyRow[column]) || 0) + value;
      }
    }
  }

  return [...groups.values()];
}

function buildIntradaySeries(rows, dateColumn, timeColumn, numericColumns, explicitDimensionColumns, ignoredDimensionColumns = []) {
  if (!rows.length) {
    return [];
  }

  const dimensionColumns =
    explicitDimensionColumns ||
    inferDimensionColumns(rows, dateColumn, numericColumns, [...ignoredDimensionColumns, timeColumn]);
  const groups = new Map();

  for (const row of rows) {
    const dateKey = normalizeDateKey(row[dateColumn]);
    if (!dateKey) {
      continue;
    }

    const groupKey = JSON.stringify(dimensionColumns.map((column) => row[column] ?? ""));
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        dimensionColumns,
        dimensionValues: Object.fromEntries(dimensionColumns.map((column) => [column, row[column]])),
        rowsByDate: new Map(),
      });
    }

    const group = groups.get(groupKey);
    if (!group.rowsByDate.has(dateKey)) {
      group.rowsByDate.set(dateKey, []);
    }
    group.rowsByDate.get(dateKey).push(row);
  }

  return [...groups.values()];
}

function resolveLatestTimeAtOrBefore(rows, timeColumn, hourValue) {
  const times = rows
    .map((row) => parseScheduleHour(row[timeColumn]))
    .filter((time) => Number.isFinite(time) && time <= hourValue);
  return times.sort((left, right) => right - left)[0];
}

function sumRowsUntilTime(rows, timeColumn, numericColumns, cutoffHour) {
  const values = Object.fromEntries(numericColumns.map((column) => [column, 0]));
  let hasAnyRow = false;

  for (const row of rows) {
    const rowHour = parseScheduleHour(row[timeColumn]);
    if (!Number.isFinite(rowHour) || rowHour > cutoffHour) {
      continue;
    }

    hasAnyRow = true;
    for (const column of numericColumns) {
      const value = toNumber(row[column]);
      if (Number.isFinite(value)) {
        values[column] += value;
      }
    }
  }

  return hasAnyRow ? values : {};
}

function sumRowsAtTime(rows, timeColumn, numericColumns, targetMinutes) {
  const values = Object.fromEntries(numericColumns.map((column) => [column, 0]));
  let hasAnyRow = false;

  for (const row of rows) {
    const rowMinutes = parseScheduleMinutes(row[timeColumn]);
    if (!Number.isFinite(rowMinutes) || rowMinutes !== targetMinutes) {
      continue;
    }

    hasAnyRow = true;
    for (const column of numericColumns) {
      const value = toNumber(row[column]);
      if (Number.isFinite(value)) {
        values[column] += value;
      }
    }
  }

  return hasAnyRow ? values : null;
}

function resolveLookbackAnchorDate(series, latestAllowedDate) {
  const dates = series.flatMap((item) => [...item.rowsByDate.keys()].filter((date) => date <= latestAllowedDate));
  return dates.sort().at(-1) || null;
}

function inferDimensionColumns(rows, dateColumn, numericColumns, ignoredDimensionColumns = []) {
  const numericSet = new Set(numericColumns);
  const ignoredSet = new Set(ignoredDimensionColumns);
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  return columns.filter((column) => {
    return column !== dateColumn && !numericSet.has(column) && !ignoredSet.has(column) && !isNumericColumn(rows, column);
  });
}

function isNumericColumn(rows, column) {
  return rows.some((row) => Number.isFinite(toNumber(row[column])));
}

function sortRowsByDate(rows, dateColumn) {
  if (!dateColumn) {
    return rows;
  }

  return [...rows].sort((left, right) => {
    return Date.parse(left[dateColumn]) - Date.parse(right[dateColumn]);
  });
}

function formatSeriesSuffix(item, dateColumn) {
  const parts = [];

  if (dateColumn && item.latest[dateColumn]) {
    parts.push(`${dateColumn}=${item.latest[dateColumn]}`);
  }

  for (const column of item.dimensionColumns) {
    const value = item.latest[column];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${column}=${value}`);
    }
  }

  return parts.length ? `（${parts.join("，")}）` : "";
}

function formatComparisonSuffix(item, dateColumn) {
  const parts = [];

  if (dateColumn && item.latest[dateColumn] && item.previous?.[dateColumn]) {
    parts.push(`${dateColumn} ${item.latest[dateColumn]} 对比 ${item.previous[dateColumn]}`);
  } else if (dateColumn && item.latest[dateColumn]) {
    parts.push(`${dateColumn}=${item.latest[dateColumn]}`);
  }

  for (const column of item.dimensionColumns) {
    const value = item.latest[column];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${column}=${value}`);
    }
  }

  return parts.length ? `（${parts.join("，")}）` : "";
}

function formatDateComparisonSuffix(item, dateColumn, currentDate, previousDate) {
  const parts = [`${dateColumn} ${currentDate} 对比 ${previousDate}`];

  for (const column of item.dimensionColumns) {
    const value = item.dimensionValues?.[column];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${column}=${value}`);
    }
  }

  return `（${parts.join("，")}）`;
}

function formatDimensionSuffix(item) {
  const text = formatDimensionText(item);
  return text ? `（${text.slice(1)}）` : "";
}

function formatDimensionText(item) {
  const parts = [];

  for (const column of item.dimensionColumns || []) {
    const value = item.dimensionValues?.[column];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${column}=${value}`);
    }
  }

  return parts.length ? `，${parts.join("，")}` : "";
}

function shouldSuppressCorrelatedChange(change, columnChanges, rule) {
  const suppressions = rule.correlatedChangeSuppressions || [];
  for (const suppression of suppressions) {
    const columns = suppression.columns || [];
    if (!columns.includes(change.column)) {
      continue;
    }

    const correlatedChanges = columns.map((column) => columnChanges.find((item) => item.column === column));
    if (correlatedChanges.some((item) => !item)) {
      continue;
    }

    if (suppression.sameDirection !== false && !hasSameChangeDirection(correlatedChanges)) {
      continue;
    }

    if (!isChangeRateSpreadAllowed(correlatedChanges, suppression)) {
      continue;
    }

    return true;
  }

  return false;
}

function hasSameChangeDirection(changes) {
  const directions = changes.map((change) => Math.sign(change.changeRate));
  if (directions.some((direction) => direction === 0)) {
    return false;
  }

  return directions.every((direction) => direction === directions[0]);
}

function isChangeRateSpreadAllowed(changes, suppression) {
  const rates = changes.map((change) => Math.abs(change.changeRate));
  const maxRate = Math.max(...rates);
  const minRate = Math.min(...rates);
  if (maxRate === 0) {
    return false;
  }

  const maxRelativeRateGap = suppression.maxRelativeRateGap ?? 0.5;
  return (maxRate - minRate) / maxRate <= maxRelativeRateGap;
}

function isChangeOutsideRule(changeRate, absDelta, rule) {
  if (rule.minAbsDelta !== undefined && absDelta < rule.minAbsDelta) {
    return false;
  }

  if (rule.maxAbsDelta !== undefined) {
    return absDelta > rule.maxAbsDelta;
  }

  if (rule.maxDropDelta !== undefined && changeRate < 0) {
    return absDelta > rule.maxDropDelta;
  }

  if (rule.maxRiseDelta !== undefined && changeRate > 0) {
    return absDelta > rule.maxRiseDelta;
  }

  const absChangeRate = Math.abs(changeRate);
  if (changeRate < 0 && rule.maxDropRate !== undefined) {
    return absChangeRate > rule.maxDropRate;
  }

  if (changeRate > 0 && rule.maxRiseRate !== undefined) {
    return absChangeRate > rule.maxRiseRate;
  }

  return absChangeRate > (rule.maxAbsChangeRate ?? 0.1);
}

function shouldSuppressSmallNumericChange(column, current, previous, rule) {
  if (
    rule.valueFormat === "percent" ||
    rule.disableSmallValueSuppression === true ||
    isPercentLikeMetric(column, current, previous)
  ) {
    return false;
  }

  const threshold = rule.smallValueThreshold ?? 50;
  const maxRatio = rule.smallValueMaxRatio ?? 3;
  if (!Number.isFinite(threshold) || threshold <= 0 || !Number.isFinite(maxRatio) || maxRatio <= 0) {
    return false;
  }

  const absCurrent = Math.abs(current);
  const absPrevious = Math.abs(previous);
  if (absCurrent >= threshold || absPrevious >= threshold) {
    return false;
  }

  const smaller = Math.min(absCurrent, absPrevious);
  const larger = Math.max(absCurrent, absPrevious);
  if (smaller === 0) {
    return larger === 0;
  }

  return larger / smaller <= maxRatio;
}

function isPercentLikeMetric(column, current, previous) {
  const columnName = String(column || "").toLowerCase();
  if (/率|占比|rate|ratio|conversion/.test(columnName) || columnName.includes("~")) {
    return true;
  }

  return Math.abs(current) <= 1 && Math.abs(previous) <= 1;
}

function resolveExpectedProgress(schedule, hourValue) {
  const points = normalizeProgressSchedule(schedule);
  if (!points.length) {
    return Math.min(1, Math.max(0, hourValue / 24));
  }

  if (hourValue <= points[0].hour) {
    return points[0].progress;
  }

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (hourValue <= current.hour) {
      const ratio = (hourValue - previous.hour) / (current.hour - previous.hour);
      return previous.progress + (current.progress - previous.progress) * ratio;
    }
  }

  return points[points.length - 1].progress;
}

function normalizeProgressSchedule(schedule) {
  if (!schedule) {
    return [];
  }

  const entries = Array.isArray(schedule)
    ? schedule.map((item) => [item.time ?? item.hour, item.progress])
    : Object.entries(schedule);

  return entries
    .map(([time, progress]) => ({
      hour: parseScheduleHour(time),
      progress: Number(progress),
    }))
    .filter((item) => Number.isFinite(item.hour) && Number.isFinite(item.progress))
    .sort((left, right) => left.hour - right.hour);
}

function parseScheduleHour(value) {
  if (typeof value === "number") {
    return value;
  }

  const [hour, minute = "0"] = String(value).split(":");
  return Number(hour) + Number(minute) / 60;
}

function parseScheduleMinutes(value) {
  const hourValue = parseScheduleHour(value);
  if (!Number.isFinite(hourValue)) {
    return Number.NaN;
  }

  return Math.round(hourValue * 60);
}

function formatHourLabel(hourValue) {
  const hour = Math.floor(hourValue);
  const minute = Math.round((hourValue - hour) * 60);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildExpectedTimePointMinutes(rule, localNow) {
  const intervalMinutes = rule.intervalMinutes ?? 30;
  const startMinutes = parseScheduleMinutes(rule.startTime || "00:00");
  const nowMinutes = localNow.hour * 60 + localNow.minute;
  const allowedDelayMinutes = rule.allowedDelayMinutes ?? rule.dataDelayMinutes ?? 0;
  const effectiveNowMinutes = nowMinutes - allowedDelayMinutes;
  const endMinutes = rule.cutoffTime
    ? parseScheduleMinutes(rule.cutoffTime)
    : Math.floor(effectiveNowMinutes / intervalMinutes) * intervalMinutes;
  const times = [];

  if (
    !Number.isFinite(startMinutes) ||
    !Number.isFinite(endMinutes) ||
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes <= 0 ||
    endMinutes < startMinutes
  ) {
    return times;
  }

  for (let time = startMinutes; time <= endMinutes; time += intervalMinutes) {
    times.push(time);
  }
  return times;
}

function resolveCompletenessExpectedTimes(rule, fixedExpectedTimes, previousRows, timeColumn) {
  const source = rule.expectedTimePointSource || rule.expectedTimesFrom;
  if (source !== "previousDay") {
    return fixedExpectedTimes;
  }

  const cutoff = fixedExpectedTimes.at(-1);
  if (!Number.isFinite(cutoff)) {
    return [];
  }

  return [
    ...new Set(
      previousRows
        .map((row) => parseScheduleMinutes(row[timeColumn]))
        .filter((time) => Number.isFinite(time) && time <= cutoff),
    ),
  ].sort((left, right) => left - right);
}

function formatCompletenessExpectation(rule, expectedTimes, previousDate) {
  if ((rule.expectedTimePointSource || rule.expectedTimesFrom) === "previousDay") {
    return `期望按 ${previousDate} 已有时间点对齐，截止 ${formatHourLabel(expectedTimes.at(-1) / 60)}`;
  }

  return `期望 ${formatHourLabel(expectedTimes[0] / 60)}~${formatHourLabel(expectedTimes.at(-1) / 60)} 每 ${
    rule.intervalMinutes ?? 30
  } 分钟`;
}

function formatTimePointList(times, maxItems = 8) {
  const shown = times.slice(0, maxItems).map((time) => formatHourLabel(time / 60));
  if (times.length > maxItems) {
    shown.push(`等${times.length}个点`);
  }
  return shown.join("、");
}

function resolveNow(rule) {
  return rule.now ? new Date(rule.now) : new Date();
}

function getZonedNow(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    timeLabel: `${parts.hour}:${parts.minute}`,
  };
}

function getZonedDateKey(date, timezone) {
  return getZonedNow(date, timezone).dateKey;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDateGapDays(previousDateKey, currentDateKey) {
  const previous = new Date(`${previousDateKey}T00:00:00Z`);
  const current = new Date(`${currentDateKey}T00:00:00Z`);
  return (current.getTime() - previous.getTime()) / 86_400_000;
}

function normalizeDateKey(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function limitMessages(messages, rule) {
  const limit = rule.maxAnomaliesPerCard || 20;
  if (messages.length <= limit) {
    return messages;
  }
  return [
    ...messages.slice(0, limit),
    `还有 ${messages.length - limit} 条同类异常被省略`,
  ];
}

function normalizeMessages(result) {
  if (!result) {
    return [];
  }
  return Array.isArray(result) ? result : [result];
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }
  return Number(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return Number(value.toPrecision(8)).toString();
}

function formatMetricValue(value, rule) {
  if (rule.valueFormat === "percent") {
    return formatPercent(value);
  }

  return formatNumber(value);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPercent(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPercent(value)}`;
}

function formatChangeDescription(changeRate, delta, rule) {
  if (isAbsoluteDeltaRule(rule)) {
    return `绝对变化 ${formatSignedPercentagePoint(delta)}`;
  }

  return `波动 ${formatSignedPercent(changeRate)}`;
}

function isAbsoluteDeltaRule(rule) {
  return rule.maxAbsDelta !== undefined || rule.maxDropDelta !== undefined || rule.maxRiseDelta !== undefined;
}

function formatSignedPercentagePoint(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}个百分点`;
}

function buildAnomaly(dashboard, card, type, message, context = null) {
  return {
    country: dashboard.country || null,
    countryCode: dashboard.countryCode || dashboard.country?.code,
    countryName: dashboard.countryName || dashboard.country?.name,
    dashboardTitle: dashboard.sourcePanelTitle || dashboard.title,
    dashboardUrl: dashboard.url,
    cardTitle: card.title,
    cardId: card.cardId,
    dashcardId: card.dashcardId,
    context,
    type,
    message,
  };
}

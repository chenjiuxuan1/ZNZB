import { uniqueStrings } from "./utils.mjs";

export function buildPanelSnapshot(panel, queryResponse) {
  const querySummaries = Object.entries(queryResponse.results || {}).map(([refId, result]) =>
    summarizeQueryResult(refId, result),
  );

  const numericSeries = querySummaries.flatMap((item) => item.numericSeries);
  const textValues = uniqueStrings(querySummaries.flatMap((item) => item.textValues));
  const rowCount = Math.max(0, ...querySummaries.map((item) => item.rowCount));
  const queryErrors = querySummaries.filter((item) => item.error).map((item) => item.error);
  const latestTimestamp = Math.max(
    0,
    ...numericSeries.map((series) => series.latestTimestamp || 0),
  );

  return {
    panelId: panel.id,
    panelTitle: panel.title || `Panel ${panel.id}`,
    panelType: panel.type,
    rowCount,
    hasData: rowCount > 0 || numericSeries.length > 0 || textValues.length > 0,
    latestTimestamp: latestTimestamp || null,
    numericSeries,
    textValues,
    queryErrors,
  };
}

export function selectSeries(snapshot, rule = {}) {
  const candidates = snapshot.numericSeries.filter((series) => {
    if (rule.refId && series.refId !== rule.refId) {
      return false;
    }

    if (rule.fieldNameContains && !series.fieldName.includes(rule.fieldNameContains)) {
      return false;
    }

    return true;
  });

  return candidates.sort((left, right) => {
    return (right.latestTimestamp || 0) - (left.latestTimestamp || 0);
  })[0];
}

function summarizeQueryResult(refId, result) {
  if (result?.error) {
    return {
      refId,
      error: `${refId}: ${result.error}`,
      rowCount: 0,
      numericSeries: [],
      textValues: [],
    };
  }

  const frames = result?.frames || [];
  const frameSummaries = frames.map((frame) => summarizeFrame(refId, frame));

  return {
    refId,
    error: null,
    rowCount: Math.max(0, ...frameSummaries.map((item) => item.rowCount)),
    numericSeries: frameSummaries.flatMap((item) => item.numericSeries),
    textValues: uniqueStrings(frameSummaries.flatMap((item) => item.textValues)),
  };
}

function summarizeFrame(refId, frame) {
  const fields = frame?.schema?.fields || frame?.fields || [];
  const values = frame?.data?.values || frame?.values || [];
  const rowCount = Math.max(0, ...values.map((column) => column.length || 0));
  const numericSeries = [];
  const textValues = [];
  const timeIndex = fields.findIndex((field) => field.type === "time");

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const column = values[index] || [];

    if (field.type === "number") {
      const latestIndex = findLastFiniteIndex(column);
      if (latestIndex === -1) {
        continue;
      }

      const previousIndex = findLastFiniteIndex(column, latestIndex - 1);
      numericSeries.push({
        refId,
        fieldName: field.name || `${refId}-${index}`,
        latestValue: Number(column[latestIndex]),
        previousValue: previousIndex >= 0 ? Number(column[previousIndex]) : null,
        latestTimestamp: resolveTimestamp(values[timeIndex]?.[latestIndex]),
      });
      continue;
    }

    if (field.type === "string") {
      for (const value of column) {
        if (typeof value === "string" && value.trim()) {
          textValues.push(value.trim());
        }
      }
    }
  }

  return {
    rowCount,
    numericSeries,
    textValues,
  };
}

function findLastFiniteIndex(values, start = values.length - 1) {
  for (let index = start; index >= 0; index -= 1) {
    if (Number.isFinite(Number(values[index]))) {
      return index;
    }
  }

  return -1;
}

function resolveTimestamp(value) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}


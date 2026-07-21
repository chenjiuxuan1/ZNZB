import { createHash } from "node:crypto";
import { formatUpdateCadence, inferUpdateCadence } from "./update-cadence.mjs";

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 400;
const DEFAULT_MAX_EVENTS = 500;

export function buildObservationKey({ countryCode, dashboardUuid, dashcardId, cardId, context }) {
  return [countryCode || "", dashboardUuid || "", dashcardId ?? "", cardId ?? "", context || ""].join("::");
}

export function resolveResultSchema(rows, card = {}, rules = []) {
  const columns = [...new Set((rows || []).flatMap((row) => Object.keys(row || {})))];
  const configuredDates = rules.map((rule) => rule.dateColumn).filter(Boolean);
  const dimensionDates = (card.dimensions || []).filter((column) => isDateColumnName(column));
  const dateColumn = firstExistingDateColumn(columns, [...configuredDates, ...dimensionDates], rows) || inferDateColumn(rows);

  const configuredMetrics = rules.flatMap((rule) => rule.columns || rule.metricColumns || (rule.column ? [rule.column] : []));
  const configuredExisting = unique(configuredMetrics).filter((column) => columns.includes(column));
  const cardMetrics = unique(card.metrics || []).filter((column) => columns.includes(column));
  const inferredMetrics = columns.filter((column) => column !== dateColumn && hasNumericValue(rows, column));
  const metricColumns = configuredExisting.length ? configuredExisting : cardMetrics.length ? cardMetrics : inferredMetrics;
  const schemaMismatch = Boolean(
    configuredDates.length && !configuredDates.some((column) => columns.includes(column)) ||
    configuredMetrics.length && !configuredMetrics.some((column) => columns.includes(column)),
  );

  return { columns, dateColumn, metricColumns, schemaMismatch };
}

export function observeCardResult({ cache, dashboard, card, context = null, rows = [], rules = [], checkedAt, options = {} }) {
  const observedAt = new Date(checkedAt || Date.now()).toISOString();
  const timezone = dashboard.timezone || dashboard.country?.timezone || "Asia/Jakarta";
  const countryCode = dashboard.countryCode || dashboard.country?.code || "";
  const key = buildObservationKey({
    countryCode,
    dashboardUuid: dashboard.uuid,
    dashcardId: card.dashcardId,
    cardId: card.cardId,
    context,
  });
  const schema = resolveResultSchema(rows, card, rules);
  const dates = schema.dateColumn
    ? unique(rows.map((row) => normalizeDateKey(row?.[schema.dateColumn])).filter(Boolean)).sort()
    : [];
  const latestBusinessDate = dates.at(-1) || null;
  const metricRows = latestBusinessDate
    ? rows.filter((row) => normalizeDateKey(row?.[schema.dateColumn]) === latestBusinessDate)
    : [];
  const latestHasMetrics = schema.metricColumns.length > 0 && hasAnyMetricValue(metricRows, schema.metricColumns);
  const fingerprint = fingerprintRows(metricRows.length ? metricRows : rows);
  const previous = cache.entries?.[key] || null;
  let events = [...(previous?.events || [])];

  if (latestBusinessDate && (!previous || previous.latestBusinessDate !== latestBusinessDate)) {
    events.push({ observedAt, latestBusinessDate, rowCount: rows.length, fingerprint });
  }
  events = pruneEvents(events, observedAt, options);

  const entry = {
    key,
    countryCode,
    dashboardUuid: dashboard.uuid || null,
    dashcardId: card.dashcardId ?? null,
    cardId: card.cardId ?? null,
    context,
    timezone,
    dateColumn: schema.dateColumn,
    metricColumns: schema.metricColumns,
    schemaMismatch: schema.schemaMismatch,
    firstObservedAt: previous?.firstObservedAt || observedAt,
    lastObservedAt: observedAt,
    rowCount: rows.length,
    latestBusinessDate,
    latestHasMetrics,
    fingerprint,
    events,
  };
  cache.version = 1;
  cache.entries ||= {};
  cache.entries[key] = entry;
  cache.updatedAt = observedAt;

  return { key, entry, freshness: buildFreshness(entry, rows, rules, observedAt, options) };
}

export function buildFreshness(entry, rows = [], rules = [], checkedAt = new Date().toISOString(), options = {}) {
  const dates = entry.dateColumn
    ? unique(rows.map((row) => normalizeDateKey(row?.[entry.dateColumn])).filter(Boolean)).sort()
    : [];
  const dataCadence = inferUpdateCadence(dates, {
    anchorDate: dates.at(-1) || normalizeDateKey(checkedAt),
    lookbackDays: options.lookbackDays ?? 130,
    minIntervals: options.minIntervals ?? 3,
    minConfidence: options.minConfidence ?? 0.75,
    maxIntervalDays: 31,
    maxIntervalMonths: 3,
  });
  const refreshCadence = inferRefreshCadence(entry.events, {
    timezone: entry.timezone,
    holidayDates: options.holidayDates || [],
    minIntervals: options.minIntervals ?? 3,
    minConfidence: options.minConfidence ?? 0.75,
  });
  const nextExpectedAt = refreshCadence && entry.latestBusinessDate
    ? buildNextExpectedAt(entry.latestBusinessDate, refreshCadence, entry.events, entry.timezone, options)
    : null;
  let status = "learning";
  if (!entry.dateColumn) status = "schema_error";
  else if (refreshCadence) status = nextExpectedAt && Date.parse(checkedAt) > Date.parse(nextExpectedAt) ? "overdue" : "healthy";

  return {
    status,
    dateColumn: entry.dateColumn,
    metricColumns: entry.metricColumns,
    latestBusinessDate: entry.latestBusinessDate,
    dataCadence: dataCadence ? summarizeCadence(dataCadence) : null,
    refreshCadence: refreshCadence ? summarizeCadence(refreshCadence) : null,
    nextExpectedAt,
    evidenceCount: entry.events.length,
    noData: rows.length === 0,
    emptyMetrics: rows.length > 0 && entry.metricColumns.length > 0 && !hasAnyMetricValue(rows, entry.metricColumns),
    schemaMismatch: entry.schemaMismatch,
    requiredDatePresent: null,
    historicalDateGap: findHistoricalDateGaps(dates, refreshCadence, options).length > 0,
    historicalMissingDates: findHistoricalDateGaps(dates, refreshCadence, options),
  };
}

export function inferRefreshCadence(events, options = {}) {
  const valid = (events || [])
    .filter((event) => normalizeDateKey(event.latestBusinessDate) && Number.isFinite(Date.parse(event.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const minIntervals = options.minIntervals ?? 3;
  if (valid.length < minIntervals + 1) return null;

  const dates = valid.map((event) => normalizeDateKey(event.latestBusinessDate));
  const monthly = inferUpdateCadence(dates, {
    anchorDate: dates.at(-1), lookbackDays: 500, minIntervals,
    minConfidence: options.minConfidence ?? 0.75, maxIntervalDays: 31, maxIntervalMonths: 3,
  });
  if (!monthly) return inferBusinessDaily(valid, options);
  if (monthly.unit === "day" && monthly.interval === 1) {
    return inferBusinessDaily(valid, options) || { ...monthly, kind: "calendar_day" };
  }
  return { ...monthly, kind: monthly.unit === "week" ? "week" : monthly.unit };
}

function inferBusinessDaily(events, options) {
  const gaps = events.slice(1).map((event, index) => ({
    from: normalizeDateKey(events[index].latestBusinessDate),
    to: normalizeDateKey(event.latestBusinessDate),
  }));
  const compatible = gaps.filter(({ from, to }) => nextBusinessDate(from, options.holidayDates || []) === to).length;
  const weekendJumps = gaps.filter(({ from, to }) => dateGap(from, to) > 1 && nextBusinessDate(from, options.holidayDates || []) === to).length;
  const confidence = compatible / gaps.length;
  if (weekendJumps > 0 && confidence >= (options.minConfidence ?? 0.75)) {
    return {
      unit: "business_day", interval: 1, kind: "business_day", confidence,
      sampleCount: events.length, intervalCount: gaps.length, latestDate: gaps.at(-1).to,
      nextExpectedDate: nextBusinessDate(gaps.at(-1).to, options.holidayDates || []),
    };
  }
  return null;
}

export function buildNextExpectedAt(latestDate, cadence, events, timezone, options = {}) {
  const nextDate = cadence.unit === "business_day"
    ? nextBusinessDate(latestDate, options.holidayDates || [])
    : cadence.nextExpectedDate || addCadence(latestDate, cadence);
  const minutes = Math.min(1_439, percentile(
    events.map((event) => getZonedParts(new Date(event.observedAt), timezone).minutes),
    0.9,
  ) + (options.graceMinutes ?? 120));
  return zonedDateTimeToIso(nextDate, minutes, timezone);
}

export function findHistoricalDateGaps(dates, cadence, options = {}) {
  if (!cadence || !["day", "business_day"].includes(cadence.unit) || cadence.interval !== 1 || dates.length < 2) return [];
  const present = new Set(dates);
  const latest = dates.at(-1);
  const expected = [];
  let cursor = latest;
  for (let i = 0; i < 6; i += 1) {
    cursor = cadence.unit === "business_day"
      ? previousBusinessDate(cursor, options.holidayDates || [])
      : addDays(cursor, -1);
    expected.push(cursor);
  }
  return expected.filter((date) => !present.has(date));
}

export function summarizeCadence(cadence) {
  return {
    unit: cadence.unit,
    interval: cadence.interval,
    label: cadence.unit === "business_day" ? "每工作日" : formatUpdateCadence(cadence),
    confidence: cadence.confidence,
    sampleCount: cadence.sampleCount,
    latestDate: cadence.latestDate,
    nextExpectedDate: cadence.nextExpectedDate,
  };
}

export function pruneObservationCache(cache, checkedAt = new Date().toISOString(), options = {}) {
  const cutoff = Date.parse(checkedAt) - (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  for (const [key, entry] of Object.entries(cache.entries || {})) {
    entry.events = pruneEvents(entry.events || [], checkedAt, options);
    if (Date.parse(entry.lastObservedAt || "") < cutoff && entry.events.length === 0) delete cache.entries[key];
  }
  return cache;
}

function pruneEvents(events, checkedAt, options) {
  const cutoff = Date.parse(checkedAt) - (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  return events.filter((event) => Date.parse(event.observedAt) >= cutoff).slice(-(options.maxEvents ?? DEFAULT_MAX_EVENTS));
}

function inferDateColumn(rows) {
  const columns = unique((rows || []).flatMap((row) => Object.keys(row || {})));
  return columns.find((column) => isDateColumnName(column) && rows.some((row) => normalizeDateKey(row?.[column])))
    || columns.find((column) => rows.filter((row) => row?.[column] != null).length > 0 && rows.every((row) => row?.[column] == null || normalizeDateKey(row[column])))
    || null;
}

function isDateColumnName(column) { return /date|day|日期|时间/i.test(String(column)); }
function firstExisting(columns, candidates) { return candidates.find((column) => columns.includes(column)) || null; }
function firstExistingDateColumn(columns, candidates, rows) {
  return candidates.find((column) =>
    columns.includes(column) && rows.some((row) => normalizeDateKey(row?.[column])),
  ) || null;
}
function unique(values) { return [...new Set(values)]; }
function hasNumericValue(rows, column) { return rows.some((row) => isMetricValue(row?.[column])); }
function hasAnyMetricValue(rows, columns) { return rows.some((row) => columns.some((column) => isMetricValue(row?.[column]))); }
function isMetricValue(value) { return value !== null && value !== "" && Number.isFinite(Number(value)); }
function fingerprintRows(rows) { return createHash("sha256").update(stableStringify(rows)).digest("hex"); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function normalizeDateKey(value) {
  const match = String(value ?? "").trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}
function dateGap(from, to) { return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS; }
function addDays(date, count) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
function nextBusinessDate(date, holidays) { let next = addDays(date, 1); while (isWeekend(next) || holidays.includes(next)) next = addDays(next, 1); return next; }
function previousBusinessDate(date, holidays) { let next = addDays(date, -1); while (isWeekend(next) || holidays.includes(next)) next = addDays(next, -1); return next; }
function isWeekend(date) { const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return day === 0 || day === 6; }
function addCadence(date, cadence) {
  if (cadence.unit === "month") {
    const source = new Date(`${date}T00:00:00Z`); const originalDay = source.getUTCDate();
    source.setUTCDate(1); source.setUTCMonth(source.getUTCMonth() + cadence.interval);
    const last = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)).getUTCDate();
    source.setUTCDate(Math.min(originalDay, last)); return source.toISOString().slice(0, 10);
  }
  return addDays(date, cadence.unit === "week" ? cadence.interval * 7 : cadence.interval);
}
function percentile(values, ratio) { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(ratio * sorted.length) - 1] : 0; }
function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { minutes: (Number(values.hour) % 24) * 60 + Number(values.minute) };
}
function zonedDateTimeToIso(dateKey, minutes, timezone) {
  const [year, month, day] = dateKey.split("-").map(Number); const hour = Math.floor(minutes / 60); const minute = minutes % 60;
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    guess += Date.UTC(year, month - 1, day, hour, minute) - represented;
  }
  return new Date(guess).toISOString();
}

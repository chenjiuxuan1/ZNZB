const DAY_MS = 86_400_000;

export function inferUpdateCadence(dateValues, options = {}) {
  const anchorDate = normalizeDateKey(options.anchorDate) || new Date().toISOString().slice(0, 10);
  const lookbackDays = options.lookbackDays ?? 130;
  const minIntervals = options.minIntervals ?? 3;
  const minConfidence = options.minConfidence ?? 0.75;
  const maxIntervalDays = options.maxIntervalDays ?? 31;
  const maxIntervalMonths = options.maxIntervalMonths ?? 3;
  const lookbackStart = addDays(anchorDate, -lookbackDays);
  const dates = [...new Set((dateValues || []).map(normalizeDateKey).filter(Boolean))]
    .filter((date) => date >= lookbackStart && date <= anchorDate)
    .sort();

  if (dates.length < minIntervals + 1) {
    return null;
  }

  const monthly = inferMonthlyCadence(dates, {
    minIntervals,
    minConfidence,
    maxIntervalMonths,
  });
  if (monthly) {
    return finalizeCadence(monthly, dates, lookbackDays);
  }

  const dayBased = inferDayBasedCadence(dates, {
    minIntervals,
    minConfidence,
    maxIntervalDays,
  });
  return dayBased ? finalizeCadence(dayBased, dates, lookbackDays) : null;
}

export function isCadenceUpdateDue(cadence, targetDate) {
  const normalizedTarget = normalizeDateKey(targetDate);
  return Boolean(cadence?.nextExpectedDate && normalizedTarget && normalizedTarget >= cadence.nextExpectedDate);
}

export function formatUpdateCadence(cadence) {
  if (!cadence) {
    return "未知频率";
  }
  if (cadence.unit === "day") {
    return cadence.interval === 1 ? "每天" : `每${cadence.interval}天`;
  }
  if (cadence.unit === "week") {
    return cadence.interval === 1 ? "每周" : `每${cadence.interval}周`;
  }
  if (cadence.unit === "month") {
    return cadence.interval === 1 ? "每月" : `每${cadence.interval}个月`;
  }
  return `每${cadence.interval}${cadence.unit}`;
}

function inferDayBasedCadence(dates, options) {
  const gaps = dates.slice(1).map((date, index) => getDateGapDays(dates[index], date));
  if (gaps.length < options.minIntervals) {
    return null;
  }

  const mode = findMode(gaps);
  if (
    !mode ||
    !Number.isInteger(mode.value) ||
    mode.value < 1 ||
    mode.value > options.maxIntervalDays ||
    mode.confidence < options.minConfidence
  ) {
    return null;
  }

  if (mode.value % 7 === 0) {
    return {
      unit: "week",
      interval: mode.value / 7,
      intervalDays: mode.value,
      confidence: mode.confidence,
      matchedIntervals: mode.count,
      intervalCount: gaps.length,
    };
  }

  return {
    unit: "day",
    interval: mode.value,
    intervalDays: mode.value,
    confidence: mode.confidence,
    matchedIntervals: mode.count,
    intervalCount: gaps.length,
  };
}

function inferMonthlyCadence(dates, options) {
  const monthIntervals = dates.slice(1).map((date, index) => {
    const previous = dates[index];
    if (!areMonthlyDatesAligned(previous, date)) {
      return null;
    }
    return getMonthGap(previous, date);
  });
  if (monthIntervals.length < options.minIntervals) {
    return null;
  }

  const mode = findMode(monthIntervals.filter((value) => Number.isInteger(value) && value > 0));
  if (
    !mode ||
    mode.value > options.maxIntervalMonths ||
    mode.count / monthIntervals.length < options.minConfidence
  ) {
    return null;
  }

  return {
    unit: "month",
    interval: mode.value,
    intervalDays: null,
    confidence: mode.count / monthIntervals.length,
    matchedIntervals: mode.count,
    intervalCount: monthIntervals.length,
  };
}

function finalizeCadence(cadence, dates, lookbackDays) {
  const latestDate = dates.at(-1);
  const nextExpectedDate = cadence.unit === "month"
    ? addMonths(latestDate, cadence.interval)
    : addDays(latestDate, cadence.intervalDays);
  return {
    ...cadence,
    sampleCount: dates.length,
    lookbackDays,
    firstDate: dates[0],
    latestDate,
    nextExpectedDate,
  };
}

function findMode(values) {
  if (!values.length) {
    return null;
  }
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const [value, count] = [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0] - right[0]
  )[0];
  return {
    value,
    count,
    confidence: count / values.length,
  };
}

function areMonthlyDatesAligned(previousDate, currentDate) {
  const previous = parseDateParts(previousDate);
  const current = parseDateParts(currentDate);
  return previous.day === current.day || (isLastDayOfMonth(previous) && isLastDayOfMonth(current));
}

function getMonthGap(previousDate, currentDate) {
  const previous = parseDateParts(previousDate);
  const current = parseDateParts(currentDate);
  return (current.year - previous.year) * 12 + current.month - previous.month;
}

function addMonths(dateKey, months) {
  const parts = parseDateParts(dateKey);
  const sourceIsMonthEnd = isLastDayOfMonth(parts);
  const monthIndex = parts.year * 12 + parts.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12 + 1;
  const lastDay = daysInMonth(year, month);
  const day = sourceIsMonthEnd ? lastDay : Math.min(parts.day, lastDay);
  return formatDateParts({ year, month, day });
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDateGapDays(previousDateKey, currentDateKey) {
  const previous = new Date(`${previousDateKey}T00:00:00Z`);
  const current = new Date(`${currentDateKey}T00:00:00Z`);
  return (current.getTime() - previous.getTime()) / DAY_MS;
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
  return formatDateParts({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  });
}

function parseDateParts(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month, day };
}

function formatDateParts({ year, month, day }) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isLastDayOfMonth({ year, month, day }) {
  return day === daysInMonth(year, month);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

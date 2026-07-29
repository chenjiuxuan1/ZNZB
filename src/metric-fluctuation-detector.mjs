export function detectMetricFluctuation(current, history, options = {}) {
  const values = normalizeNumericValues(history);
  const minHistory = options.minHistory ?? 14;
  const shortMinHistory = Math.min(options.shortMinHistory ?? 7, minHistory);
  if (!Number.isFinite(current) || values.length < shortMinHistory) {
    return {
      isAnomaly: false,
      reason: values.length < shortMinHistory ? "history_not_enough" : "current_not_numeric",
      historyCount: values.length,
    };
  }
  const isShortHistory = values.length < minHistory;

  const baseline = median(values);
  const sigmaFloorRate = options.sigmaFloorRate ?? 0.03;
  const sigmaFloor = Math.max(Math.abs(baseline) * sigmaFloorRate, options.sigmaFloor ?? 1e-9);
  const sigma = Math.max(robustSigma(values, baseline), sigmaFloor);
  const expected = ewmaForecast(values, options.ewmaAlpha ?? 0.35);
  const residual = current - expected;
  const absDelta = Math.abs(residual);
  const relativeDelta = absDelta / Math.max(Math.abs(expected), options.relativeDenominatorFloor ?? 1e-9);
  const anomalyScore = absDelta / sigma;

  const zeroResult = detectZeroAnomaly(current, values, baseline, {
    minZeroHistoryNonZeroCount: options.minZeroHistoryNonZeroCount ?? 5,
    zeroHistoryWindow: options.zeroHistoryWindow ?? 7,
    minBaselineForZero: options.minBaselineForZero ?? options.minAbsDelta ?? 10,
  });
  if (zeroResult.isAnomaly) {
    return {
      isAnomaly: true,
      reason: zeroResult.reason,
      current,
      baseline,
      expected,
      sigma,
      residual,
      absDelta,
      relativeDelta,
      anomalyScore,
      historyCount: values.length,
      dynamicRelativeThreshold: 0,
    };
  }

  const dynamicRelativeThreshold = resolveDynamicRelativeThreshold(
    sigma / Math.max(Math.abs(expected), options.relativeDenominatorFloor ?? 1e-9),
    options,
  );
  const minAbsDelta = options.minAbsDelta ?? 0;
  const minRelativeDelta = isShortHistory
    ? options.shortMinRelativeDelta ?? 0.3
    : options.minRelativeDelta ?? 0;
  const minScore = isShortHistory
    ? options.shortMinScore ?? 5
    : options.minScore ?? 3;
  const isAnomaly =
    anomalyScore >= minScore &&
    absDelta >= minAbsDelta &&
    relativeDelta >= Math.max(minRelativeDelta, dynamicRelativeThreshold);

  return {
    isAnomaly,
    reason: isAnomaly
      ? (isShortHistory ? "short_history_robust_residual_check" : "robust_residual_check")
      : "normal",
    current,
    baseline,
    expected,
    sigma,
    residual,
    absDelta,
    relativeDelta,
    anomalyScore,
    historyCount: values.length,
    isShortHistory,
    minScore,
    minRelativeDelta,
    dynamicRelativeThreshold,
  };
}

export function median(values) {
  const sorted = normalizeNumericValues(values).sort((left, right) => left - right);
  if (!sorted.length) {
    return Number.NaN;
  }

  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function robustSigma(values, center = median(values)) {
  const mad = median(values.map((value) => Math.abs(value - center)));
  return 1.4826 * mad;
}

export function ewmaForecast(values, alpha = 0.35) {
  const clean = normalizeNumericValues(values);
  if (!clean.length) {
    return Number.NaN;
  }

  return clean.slice(1).reduce((forecast, value) => alpha * value + (1 - alpha) * forecast, clean[0]);
}

export function resolveDynamicRelativeThreshold(cv, options = {}) {
  const bands = options.relativeThresholdBands || [
    { maxCv: 0.1, threshold: 0.2 },
    { maxCv: 0.25, threshold: 0.35 },
    { maxCv: 0.5, threshold: 0.6 },
  ];

  for (const band of bands) {
    if (cv < band.maxCv) {
      return band.threshold;
    }
  }

  return options.highVolatilityRelativeThreshold ?? 1;
}

function detectZeroAnomaly(current, values, baseline, options) {
  if (current !== 0 || Math.abs(baseline) < options.minBaselineForZero) {
    return { isAnomaly: false };
  }

  const window = values.slice(-options.zeroHistoryWindow);
  const nonZeroCount = window.filter((value) => value !== 0).length;
  return nonZeroCount >= options.minZeroHistoryNonZeroCount
    ? { isAnomaly: true, reason: "latest_nonzero_to_zero" }
    : { isAnomaly: false };
}

function normalizeNumericValues(values) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
}

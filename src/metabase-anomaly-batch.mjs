const MAX_CONCURRENT_BATCHES = 2;
const MAX_CASES_PER_BATCH = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TARGET_DURATION_MS = 20 * 60 * 1000;
const DEADLINE_MS = 30 * 60 * 1000;

export function getBatchInvestigationLimits() {
  return {
    maxConcurrentBatches: MAX_CONCURRENT_BATCHES,
    maxCasesPerBatch: MAX_CASES_PER_BATCH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    targetDurationMs: TARGET_DURATION_MS,
    deadlineMs: DEADLINE_MS,
  };
}

export function buildInvestigationBatches(cases = {}, { maxCasesPerBatch = MAX_CASES_PER_BATCH } = {}) {
  const groups = new Map();
  for (const item of Array.isArray(cases) ? cases : []) {
    const countryCode = String(item.countryCode || "").trim().toUpperCase();
    const sourceTable = String(item.sourceTable || "").trim().toLowerCase();
    if (!countryCode || !sourceTable || !Number.isInteger(Number(item.anomalyIndex))) continue;
    const groupKey = `${countryCode}:${sourceTable}`;
    groups.set(groupKey, [...(groups.get(groupKey) || []), { ...item, countryCode, sourceTable }]);
  }
  return [...groups.entries()].flatMap(([groupKey, items]) => items.reduce((batches, item, index) => {
    const batchIndex = Math.floor(index / MAX_CASES_PER_BATCH);
    (batches[batchIndex] ||= { groupKey, sourceTable: item.sourceTable, countryCode: item.countryCode, cases: [] }).cases.push(item);
    return batches;
  }, []));
}

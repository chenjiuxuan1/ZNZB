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

export async function runBoundedInvestigationQueue({
  batches = [],
  submit,
  waitForSettlement,
  limits = getBatchInvestigationLimits(),
  onProgress = null,
} = {}) {
  if (typeof submit !== "function" || typeof waitForSettlement !== "function") {
    throw new TypeError("submit and waitForSettlement are required");
  }
  const work = Array.isArray(batches) ? batches : [];
  let cursor = 0;
  const settled = [];
  const workerCount = Math.min(MAX_CONCURRENT_BATCHES, Math.max(1, Number(limits.maxConcurrentBatches) || 1), work.length || 1);
  const next = () => cursor < work.length ? work[cursor++] : null;
  const worker = async () => {
    for (let batch = next(); batch; batch = next()) {
      onProgress?.({ type: "batch_start", batch, submitted: cursor, total: work.length });
      try {
        await submit(batch);
        onProgress?.({ type: "batch_submitted", batch, submitted: cursor, total: work.length });
        const result = await waitForSettlement(batch);
        settled.push({ batch, result: result || { status: "completed" } });
        onProgress?.({ type: "batch_settled", batch, result, completed: settled.length, total: work.length });
      } catch (error) {
        const result = { status: "failed", error: error.message };
        settled.push({ batch, result });
        onProgress?.({ type: "batch_settled", batch, result, completed: settled.length, total: work.length });
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    total: work.length,
    completed: settled.length,
    settled,
    failed: settled.filter((item) => item.result?.status === "failed").length,
    timedOut: settled.filter((item) => item.result?.status === "timed_out").length,
  };
}

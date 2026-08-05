const MAX_CONCURRENT_BATCHES = 3;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
const TARGET_DURATION_MS = 20 * 60 * 1000;
const DEADLINE_MS = 45 * 60 * 1000;
export const MAX_DASHBOARD_ANALYSIS_BYTES = 512 * 1024;

export function getBatchInvestigationLimits() {
  return {
    maxConcurrentBatches: MAX_CONCURRENT_BATCHES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    targetDurationMs: TARGET_DURATION_MS,
    deadlineMs: DEADLINE_MS,
  };
}

export function buildDashboardAnalysisJobs(cases = []) {
  const groups = new Map();
  for (const item of Array.isArray(cases) ? cases : []) {
    const countryCode = String(item.countryCode || "").trim().toUpperCase();
    const dashboardUuid = String(item.dashboardUuid || item.anomaly?.dashboardUuid || "").trim();
    const anomalyIndex = Number(item.anomalyIndex);
    if (!countryCode || !dashboardUuid || !Number.isInteger(anomalyIndex) || anomalyIndex < 0) continue;
    const groupKey = `${countryCode}:${dashboardUuid}`;
    const group = groups.get(groupKey) || {
      stage: "dashboard_analysis",
      groupKey,
      countryCode,
      dashboardUuid,
      dashboardTitle: String(item.dashboardTitle || item.anomaly?.dashboardTitle || "").trim(),
      cases: [],
    };
    group.cases.push({ ...item, countryCode, dashboardUuid, anomalyIndex });
    groups.set(groupKey, group);
  }
  return [...groups.values()];
}

export async function runBoundedInvestigationQueue({
  batches = [],
  submit,
  waitForSettlement,
  limits = getBatchInvestigationLimits(),
  onProgress = null,
  now = () => Date.now(),
  deadlineAt = Number.POSITIVE_INFINITY,
} = {}) {
  if (typeof submit !== "function" || typeof waitForSettlement !== "function") {
    throw new TypeError("submit and waitForSettlement are required");
  }
  const work = Array.isArray(batches) ? batches : [];
  let cursor = 0;
  const settled = [];
  const notSubmitted = [];
  const workerCount = Math.min(MAX_CONCURRENT_BATCHES, Math.max(1, Number(limits.maxConcurrentBatches) || 1), work.length || 1);
  const next = () => cursor < work.length ? work[cursor++] : null;
  const worker = async () => {
    for (let batch = next(); batch; batch = next()) {
      if (now() >= deadlineAt) {
        notSubmitted.push(batch, ...work.slice(cursor));
        cursor = work.length;
        onProgress?.({ type: "global_deadline", notSubmitted, total: work.length });
        return;
      }
      onProgress?.({ type: "batch_start", batch, submitted: cursor, total: work.length });
      try {
        await submit(batch);
        onProgress?.({ type: "batch_submitted", batch, submitted: cursor, total: work.length });
        const result = await waitForSettlement(batch);
        settled.push({ batch, result: result || { status: "completed" } });
        onProgress?.({ type: "batch_settled", batch, result, completed: settled.length, total: work.length });
      } catch (error) {
        console.error(`[batch-investigation] batch ${batch.batchId || batch.groupKey || "?"} FAILED: ${error.message}`);
        const result = { status: "failed", error: error.message };
        settled.push({ batch, result });
        onProgress?.({ type: "batch_settled", batch, result, completed: settled.length, total: work.length });
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    total: work.length,
    completed: settled.filter((item) => item.result?.status === "completed").length,
    settled,
    failed: settled.filter((item) => item.result?.status === "failed").length,
    timedOut: settled.filter((item) => item.result?.status === "timed_out").length,
    notSubmitted,
  };
}

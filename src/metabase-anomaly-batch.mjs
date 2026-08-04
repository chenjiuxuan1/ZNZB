import { randomUUID } from "node:crypto";

export const MAX_CONCURRENT_BATCHES = 3;
export const MAX_CASES_PER_BATCH = 30;

/**
 * Build single-stage analysis jobs: one Dify request per anomalous dashboard.
 * Each job covers every anomalyIndex belonging to that dashboard, up to
 * MAX_CASES_PER_BATCH. Cases exceeding the limit are split into additional
 * jobs for the same dashboard (rare fallback for oversized dashboards).
 */
export function buildDashboardAnalysisJobs(cases) {
  const normalized = (cases || []).map((item, index) => ({
    ...item,
    anomalyIndex: item.anomalyIndex ?? index,
  }));

  const byDashboard = new Map();
  for (const item of normalized) {
    const key = item.dashboardUuid || "unknown";
    if (!byDashboard.has(key)) {
      byDashboard.set(key, []);
    }
    byDashboard.get(key).push(item);
  }

  const jobs = [];
  for (const [dashboardUuid, items] of byDashboard.entries()) {
    for (let index = 0; index < items.length; index += MAX_CASES_PER_BATCH) {
      const chunk = items.slice(index, index + MAX_CASES_PER_BATCH);
      jobs.push({
        id: randomUUID(),
        stage: "dashboard_analysis",
        dashboardUuid,
        dashboardTitle: chunk[0]?.dashboardTitle || "",
        cases: chunk,
      });
    }
  }

  return jobs;
}

/**
 * Legacy grouping helper kept for backward compatibility with non-AI patrols.
 * It groups anomalies by dashboard only, which is the same unit the platform
 * used before single-stage analysis. Prefer buildDashboardAnalysisJobs for
 * AI-first patrols.
 */
export function buildInvestigationBatches(cases) {
  return buildDashboardAnalysisJobs(cases);
}

/**
 * Run a bounded concurrent queue of investigation jobs.
 *
 * @param {Array} jobs - Job objects produced by buildDashboardAnalysisJobs.
 * @param {Object} options
 * @param {Function} options.execute - async (job) => void; sends the batch.
 * @param {Function} [options.onTimeout] - async (job) => void; marks unfinished.
 * @param {number} [options.concurrency] - defaults to MAX_CONCURRENT_BATCHES.
 * @param {number} [options.timeoutMs] - overall deadline (default 45 min).
 * @returns {Promise<{completed: number, timedOut: number, errors: number}>}
 */
export async function runBoundedInvestigationQueue(jobs, options = {}) {
  const execute = options.execute;
  const onTimeout = options.onTimeout || (() => Promise.resolve());
  const concurrency = Math.max(1, Math.min(
    options.concurrency || MAX_CONCURRENT_BATCHES,
    MAX_CONCURRENT_BATCHES,
  ));
  const timeoutMs = options.timeoutMs || 45 * 60 * 1000;

  if (typeof execute !== "function") {
    throw new Error("runBoundedInvestigationQueue requires options.execute");
  }

  const queue = [...jobs];
  const deadline = Date.now() + timeoutMs;
  let completed = 0;
  let errors = 0;
  let timedOut = 0;
  let index = 0;

  async function runNext() {
    while (index < queue.length && Date.now() < deadline) {
      const jobIndex = index;
      index += 1;
      const job = queue[jobIndex];
      try {
        await execute(job);
        completed += 1;
      } catch (error) {
        errors += 1;
        if (options.onError) {
          await options.onError(job, error);
        }
      }
    }
  }

  const workers = [];
  for (let worker = 0; worker < concurrency; worker += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);

  while (index < queue.length) {
    const job = queue[index];
    index += 1;
    try {
      await onTimeout(job);
      timedOut += 1;
    } catch (error) {
      errors += 1;
      if (options.onError) {
        await options.onError(job, error);
      }
    }
  }

  return { completed, timedOut, errors };
}

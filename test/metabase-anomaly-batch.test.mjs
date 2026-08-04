import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildDashboardAnalysisJobs,
  buildInvestigationBatches,
  MAX_CASES_PER_BATCH,
  MAX_CONCURRENT_BATCHES,
  runBoundedInvestigationQueue,
} from "../src/metabase-anomaly-batch.mjs";
import {
  completeMetabaseAnomalyBatch,
  finalizeAiFirstMetabasePatrol,
  normalizeDashboardAnalysisVerdict,
  prepareMetabaseInvestigationBatches,
} from "../src/platform-api.mjs";

function makeCase(overrides = {}) {
  return {
    anomalyIndex: 0,
    dashboardUuid: "dash-1",
    dashboardTitle: "OKR",
    cardId: 1,
    dashcardId: 2,
    metricName: "规模",
    ...overrides,
  };
}

test("exports correct concurrency and batch limits", () => {
  assert.equal(MAX_CONCURRENT_BATCHES, 3);
  assert.equal(MAX_CASES_PER_BATCH, 30);
});

test("buildDashboardAnalysisJobs groups cases by dashboard", () => {
  const cases = [
    makeCase({ anomalyIndex: 0, dashboardUuid: "dash-1" }),
    makeCase({ anomalyIndex: 1, dashboardUuid: "dash-1" }),
    makeCase({ anomalyIndex: 2, dashboardUuid: "dash-2" }),
  ];

  const jobs = buildDashboardAnalysisJobs(cases);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].stage, "dashboard_analysis");
  assert.equal(jobs[0].dashboardUuid, "dash-1");
  assert.equal(jobs[0].cases.length, 2);
  assert.equal(jobs[1].dashboardUuid, "dash-2");
  assert.equal(jobs[1].cases.length, 1);
});

test("buildDashboardAnalysisJobs splits oversized dashboards into chunks of 30", () => {
  const cases = Array.from({ length: 35 }, (_, index) =>
    makeCase({ anomalyIndex: index, dashboardUuid: "dash-big" }),
  );

  const jobs = buildDashboardAnalysisJobs(cases);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].cases.length, 30);
  assert.equal(jobs[1].cases.length, 5);
  assert.ok(jobs.every((job) => job.stage === "dashboard_analysis"));
});

test("buildDashboardAnalysisJobs falls back to anomalyIndex from index", () => {
  const cases = [{ dashboardUuid: "dash-1" }];
  const jobs = buildDashboardAnalysisJobs(cases);
  assert.equal(jobs[0].cases[0].anomalyIndex, 0);
});

test("prepareMetabaseInvestigationBatches is an alias for buildDashboardAnalysisJobs", () => {
  const cases = [makeCase({ anomalyIndex: 0 })];
  const jobs = prepareMetabaseInvestigationBatches(cases);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].stage, "dashboard_analysis");
});

test("buildInvestigationBatches remains as legacy grouping helper", () => {
  const cases = [
    makeCase({ anomalyIndex: 0, dashboardUuid: "dash-1" }),
    makeCase({ anomalyIndex: 1, dashboardUuid: "dash-2" }),
  ];
  const jobs = buildInvestigationBatches(cases);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.stage === "dashboard_analysis"));
});

test("runBoundedInvestigationQueue executes jobs concurrently up to limit", async () => {
  const running = new Set();
  let maxRunning = 0;
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    id: `job-${index}`,
    cases: [makeCase({ anomalyIndex: index })],
  }));

  const stats = await runBoundedInvestigationQueue(jobs, {
    concurrency: 3,
    async execute(job) {
      running.add(job.id);
      maxRunning = Math.max(maxRunning, running.size);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running.delete(job.id);
    },
  });

  assert.equal(stats.completed, 6);
  assert.equal(stats.timedOut, 0);
  assert.equal(stats.errors, 0);
  assert.equal(maxRunning, 3);
});

test("runBoundedInvestigationQueue marks remaining jobs as timed out", async () => {
  const jobs = Array.from({ length: 4 }, (_, index) => ({
    id: `job-${index}`,
    cases: [makeCase({ anomalyIndex: index })],
  }));
  const timedOut = [];

  const stats = await runBoundedInvestigationQueue(jobs, {
    concurrency: 1,
    timeoutMs: 10,
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    async onTimeout(job) {
      timedOut.push(job.id);
    },
  });

  assert.ok(stats.completed <= 1);
  assert.equal(timedOut.length, jobs.length - stats.completed);
  assert.equal(stats.timedOut, timedOut.length);
});

test("runBoundedInvestigationQueue reports execution errors", async () => {
  const jobs = [{ id: "job-0", cases: [makeCase({ anomalyIndex: 0 })] }];
  const stats = await runBoundedInvestigationQueue(jobs, {
    async execute() {
      throw new Error("boom");
    },
  });

  assert.equal(stats.completed, 0);
  assert.equal(stats.errors, 1);
});

test("normalizeDashboardAnalysisVerdict fills missing fields", () => {
  const verdict = normalizeDashboardAnalysisVerdict({
    anomalyIndex: 7,
    dataSideVerdict: "data_issue",
    notificationAction: "send",
    chartVisibility: "hide_verified_normal",
    summary: "Summary text",
    confidence: 0.9,
  });

  assert.equal(verdict.anomalyIndex, 7);
  assert.equal(verdict.dataSideVerdict, "data_issue");
  assert.equal(verdict.notificationAction, "send");
  assert.equal(verdict.chartVisibility, "hide_verified_normal");
  assert.equal(verdict.summary, "Summary text");
  assert.deepEqual(verdict.possibleCauses, []);
  assert.equal(verdict.confidence, 0.9);
  assert.deepEqual(verdict.limitations, []);
});

test("normalizeDashboardAnalysisVerdict rejects unknown enum values", () => {
  const verdict = normalizeDashboardAnalysisVerdict({
    anomalyIndex: 1,
    dataSideVerdict: "unknown_value",
    notificationAction: "unknown_action",
    chartVisibility: "unknown_visibility",
  });

  assert.equal(verdict.dataSideVerdict, "insufficient_evidence");
  assert.equal(verdict.notificationAction, "enrich_only");
  assert.equal(verdict.chartVisibility, "show");
});

test("completeMetabaseAnomalyBatch writes verdicts to cache", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "metabase-anomaly-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const result = await completeMetabaseAnomalyBatch({
    rootDir,
    batchId: "batch-1",
    results: [
      { anomalyIndex: 0, dataSideVerdict: "data_issue" },
      { anomalyIndex: 1, dataSideVerdict: "verified_normal" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.processed, 2);

  const cache = JSON.parse(
    await fs.readFile(path.join(rootDir, "config/metabase-anomaly-analyses.json"), "utf8"),
  );
  assert.equal(Object.keys(cache.verdicts).length, 2);
  assert.equal(cache.verdicts["0"].dataSideVerdict, "data_issue");
  assert.equal(cache.verdicts["1"].dataSideVerdict, "verified_normal");
  assert.equal(cache.batches[0].status, "completed");
});

test("completeMetabaseAnomalyBatch rejects more than 30 results", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "metabase-anomaly-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  await assert.rejects(
    completeMetabaseAnomalyBatch({
      rootDir,
      batchId: "batch-2",
      results: Array.from({ length: 31 }, (_, index) => ({ anomalyIndex: index })),
    }),
    /不能超过 30 条/,
  );
});

test("finalizeAiFirstMetabasePatrol submits all batches when agent enabled", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "metabase-anomaly-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const submitted = [];
  const cases = [
    makeCase({ anomalyIndex: 0, dashboardUuid: "dash-1" }),
    makeCase({ anomalyIndex: 1, dashboardUuid: "dash-2" }),
  ];

  const result = await finalizeAiFirstMetabasePatrol({
    rootDir,
    cases,
    agentEnabled: true,
    async requestFn(batch) {
      submitted.push(batch.id);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentEnabled, true);
  assert.equal(result.phases.analysis.submitted, 2);
  assert.equal(submitted.length, 2);
});

test("finalizeAiFirstMetabasePatrol marks batches timed out when agent disabled", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "metabase-anomaly-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const cases = [makeCase({ anomalyIndex: 0, dashboardUuid: "dash-1" })];

  const result = await finalizeAiFirstMetabasePatrol({
    rootDir,
    cases,
    agentEnabled: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentEnabled, false);
  assert.equal(result.phases.analysis.submitted, 0);
  assert.equal(result.phases.analysis.timedOut, 1);

  const cache = JSON.parse(
    await fs.readFile(path.join(rootDir, "config/metabase-anomaly-analyses.json"), "utf8"),
  );
  assert.equal(cache.batches.length, 1);
  assert.equal(cache.batches[0].status, "timed_out");
  assert.equal(cache.batches[0].reason, "METABASE_ANOMALY_AGENT_ENABLED=0");
});

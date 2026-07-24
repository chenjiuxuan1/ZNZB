import { createHash } from "node:crypto";
import { createQwenAnomalyReasoner } from "./qwen-anomaly-reasoner.mjs";
import { createSrBoxVerificationExecutor } from "./sr-box-verification-client.mjs";

export const VERIFICATION_STATUS = Object.freeze({
  CONFIRMED_ANOMALY: "confirmed_anomaly",
  FALSE_POSITIVE: "false_positive",
  DATA_QUALITY_ISSUE: "data_quality_issue",
  UNVERIFIED: "unverified",
});

const DEFAULT_ELIGIBLE_TYPES = [
  "completeDayChange",
  "latestDayOverDayChange",
  "intradayProgress",
  "intradaySameTimeChange",
  "intradayTimePointChange",
  "latestValueOutsideRange",
  "changeRateOutsideRange",
];

export class AnomalyVerifierAgent {
  constructor({ config = {}, executeSql = null, reasoner = null, now = () => new Date() } = {}) {
    this.config = normalizeConfig(config);
    this.executeSql = executeSql || (
      this.config.enabled ? createSrBoxVerificationExecutor(this.config.executor) : null
    );
    this.reasoner = reasoner || createQwenAnomalyReasoner(this.config.llm);
    this.now = now;
  }

  async verifyResult(result = {}, context = {}) {
    const originalAnomalies = Array.isArray(result.anomalies) ? result.anomalies : [];
    if (!this.config.enabled) {
      return {
        ...result,
        verification: {
          enabled: false,
          status: "disabled",
          checkedAt: null,
          candidateCount: 0,
          confirmedCount: 0,
          falsePositiveCount: 0,
          dataQualityIssueCount: 0,
          unverifiedCount: 0,
          records: [],
        },
      };
    }

    const checkedAt = this.now().toISOString();
    const eligibleTypes = new Set(this.config.eligibleTypes);
    const retainedAnomalies = [];
    const suppressedAnomalies = [];
    const records = [];
    let candidateCount = 0;

    for (const anomaly of originalAnomalies) {
      if (!eligibleTypes.has(anomaly.type)) {
        retainedAnomalies.push(anomaly);
        continue;
      }

      candidateCount += 1;
      let record;
      if (candidateCount > this.config.maxCandidates) {
        record = buildUnverifiedRecord(anomaly, null, "超过单次复核数量上限，保留原异常");
      } else {
        const plan = this.config.plans.find((item) => planMatches(item, anomaly));
        record = await this.verifyAnomaly(anomaly, plan, {
          checkedAt: result.checkedAt || checkedAt,
          ...context,
        });
      }

      records.push(record);
      const annotated = annotateAnomaly(anomaly, record);
      if (record.status === VERIFICATION_STATUS.FALSE_POSITIVE) {
        suppressedAnomalies.push(annotated);
      } else {
        retainedAnomalies.push(annotated);
      }
    }

    const counts = countStatuses(records);
    return {
      ...result,
      originalAnomalyCount: originalAnomalies.length,
      anomalyCount: retainedAnomalies.length,
      anomalies: retainedAnomalies,
      suppressedAnomalyCount: suppressedAnomalies.length,
      suppressedAnomalies,
      verification: {
        enabled: true,
        status: records.some((item) => item.status === VERIFICATION_STATUS.UNVERIFIED)
          ? "partial"
          : "completed",
        checkedAt,
        candidateCount,
        confirmedCount: counts[VERIFICATION_STATUS.CONFIRMED_ANOMALY],
        falsePositiveCount: counts[VERIFICATION_STATUS.FALSE_POSITIVE],
        dataQualityIssueCount: counts[VERIFICATION_STATUS.DATA_QUALITY_ISSUE],
        unverifiedCount: counts[VERIFICATION_STATUS.UNVERIFIED],
        llm: summarizeLlmAnalysis(records, this.config.llm),
        records,
      },
    };
  }

  async verifyAnomaly(anomaly, plan, context = {}) {
    if (!plan) {
      const record = buildUnverifiedRecord(anomaly, null, "没有匹配的血缘与复核计划，保留原异常");
      record.llmAnalysis = await this.analyzeWithReasoner({
        mode: "plan-suggestion",
        anomaly,
      });
      return record;
    }
    if (!this.executeSql) {
      const record = buildUnverifiedRecord(anomaly, plan, "SR Box 只读执行器未配置，保留原异常");
      record.llmAnalysis = await this.analyzeWithReasoner({
        mode: "plan-suggestion",
        anomaly,
        plan,
      });
      return record;
    }

    const queryEvidence = [];
    try {
      for (const schemaSql of plan.schemaSql) {
        const renderedSql = renderSqlTemplate(schemaSql, anomaly, context);
        const response = await this.executeSql({
          country: plan.route || anomaly.countryCode,
          sql: renderedSql,
          purpose: "anomaly-lineage-schema-check",
          taskName: `anomaly-verifier-${plan.id}`,
        });
        queryEvidence.push(summarizeQueryEvidence("schema", renderedSql, response));
      }

      const verificationSql = renderSqlTemplate(plan.verificationSql, anomaly, context);
      const response = await this.executeSql({
        country: plan.route || anomaly.countryCode,
        sql: verificationSql,
        purpose: "anomaly-verification",
        taskName: `anomaly-verifier-${plan.id}`,
      });
      queryEvidence.push(summarizeQueryEvidence("verification", verificationSql, response));
      const decision = decideFromResponse(response, plan, this.config.minFalsePositiveConfidence);

      const record = {
        anomalyKey: anomalyKey(anomaly),
        planId: plan.id,
        status: decision.status,
        finalStatus: decision.status === VERIFICATION_STATUS.FALSE_POSITIVE ? "normal" : "anomaly",
        confidence: decision.confidence,
        reason: decision.reason,
        sourceTables: plan.sourceTables,
        lineageStatus: plan.sourceTables.length > 0 ? "configured" : "missing",
        evidence: {
          ...decision.evidence,
          queries: queryEvidence,
        },
      };
      record.llmAnalysis = await this.analyzeWithReasoner({
        mode: "evidence-review",
        anomaly,
        plan,
        decision,
        evidence: decision.evidence,
      });
      return record;
    } catch (error) {
      const record = {
        ...buildUnverifiedRecord(anomaly, plan, `数据库复核失败：${error.message}`),
        evidence: { queries: queryEvidence },
      };
      record.llmAnalysis = await this.analyzeWithReasoner({
        mode: "plan-suggestion",
        anomaly,
        plan,
      });
      return record;
    }
  }

  async analyzeWithReasoner(input) {
    try {
      return await this.reasoner.analyze(input);
    } catch (error) {
      return {
        enabled: this.config.llm.enabled,
        status: "failed",
        model: this.config.llm.model,
        reason: error.message,
      };
    }
  }
}

export function createAnomalyVerifierAgent(options = {}) {
  return new AnomalyVerifierAgent(options);
}

export function renderSqlTemplate(sql, anomaly = {}, context = {}) {
  const values = {
    anomalyType: anomaly.type,
    cardId: anomaly.cardId,
    cardTitle: anomaly.cardTitle,
    checkedAt: context.checkedAt,
    countryCode: anomaly.countryCode,
    countryName: anomaly.countryName,
    dashboardTitle: anomaly.dashboardTitle,
    dashboardUuid: anomaly.dashboardUuid,
    dashcardId: anomaly.dashcardId,
  };

  return String(sql || "").replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Unsupported verification SQL template variable: ${key}`);
    }
    return sqlLiteral(values[key]);
  });
}

function normalizeConfig(config) {
  return {
    enabled: config.enabled === true,
    eligibleTypes: Array.isArray(config.eligibleTypes) && config.eligibleTypes.length
      ? config.eligibleTypes.map(String)
      : DEFAULT_ELIGIBLE_TYPES,
    minFalsePositiveConfidence: clampConfidence(config.minFalsePositiveConfidence, 0.85),
    maxCandidates: positiveInteger(config.maxCandidates, 20),
    executor: config.executor || {},
    llm: {
      enabled: config.llm?.enabled === true,
      provider: "dashscope",
      model: String(config.llm?.model || "qwen3.6-plus"),
      baseUrl: String(config.llm?.baseUrl || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
      apiKeyEnv: String(config.llm?.apiKeyEnv || "DASHSCOPE_API_KEY"),
      temperature: config.llm?.temperature ?? 0.1,
      maxTokens: config.llm?.maxTokens ?? 1800,
      timeoutSeconds: config.llm?.timeoutSeconds ?? 60,
    },
    plans: (config.plans || [])
      .filter((plan) => plan && plan.enabled !== false)
      .map((plan, index) => ({
        ...plan,
        id: String(plan.id || `plan-${index + 1}`),
        match: plan.match || {},
        route: plan.route ? String(plan.route) : "",
        sourceTables: Array.isArray(plan.sourceTables) ? plan.sourceTables.map(String) : [],
        schemaSql: Array.isArray(plan.schemaSql) ? plan.schemaSql.filter(Boolean).map(String) : [],
        verificationSql: String(plan.verificationSql || ""),
        resultFields: plan.resultFields || {},
      }))
      .filter((plan) => plan.verificationSql),
  };
}

function planMatches(plan, anomaly) {
  const match = plan.match || {};
  return matchesValue(anomaly.countryCode, match.countryCode, match.countryCodes, match.countryCodePattern)
    && matchesValue(anomaly.dashboardTitle, match.dashboardTitle, match.dashboardTitles, match.dashboardTitlePattern)
    && matchesValue(anomaly.cardTitle, match.cardTitle, match.cardTitles, match.cardTitlePattern)
    && matchesValue(anomaly.type, match.type, match.types, match.typePattern)
    && matchesNumericValue(anomaly.cardId, match.cardId, match.cardIds);
}

function matchesValue(actual, expected, expectedList, pattern) {
  const text = String(actual ?? "");
  if (expected !== undefined && text !== String(expected)) {
    return false;
  }
  if (Array.isArray(expectedList) && !expectedList.map(String).includes(text)) {
    return false;
  }
  if (pattern && !new RegExp(pattern).test(text)) {
    return false;
  }
  return true;
}

function matchesNumericValue(actual, expected, expectedList) {
  if (expected !== undefined && Number(actual) !== Number(expected)) {
    return false;
  }
  if (Array.isArray(expectedList) && !expectedList.map(Number).includes(Number(actual))) {
    return false;
  }
  return true;
}

function decideFromResponse(response, plan, minFalsePositiveConfidence) {
  const row = Array.isArray(response?.rows) ? response.rows[0] : null;
  if (!row) {
    return {
      status: VERIFICATION_STATUS.UNVERIFIED,
      confidence: 0,
      reason: "复核 SQL 没有返回判定记录",
      evidence: standardizedEvidence({}, plan),
    };
  }

  const fields = {
    verdict: "verdict",
    confidence: "confidence",
    reason: "reason",
    sourceComplete: "source_complete",
    isAnomaly: "is_anomaly",
    dataQualityIssue: "data_quality_issue",
    observedValue: "observed_value",
    baselineLow: "baseline_low",
    baselineHigh: "baseline_high",
    ...plan.resultFields,
  };
  const confidence = clampConfidence(row[fields.confidence], 0);
  const sourceComplete = toBoolean(row[fields.sourceComplete]);
  const dataQualityIssue = toBoolean(row[fields.dataQualityIssue]);
  const isAnomaly = toBoolean(row[fields.isAnomaly]);
  let status = normalizeVerdict(row[fields.verdict]);

  if (!status) {
    if (dataQualityIssue === true) {
      status = VERIFICATION_STATUS.DATA_QUALITY_ISSUE;
    } else if (sourceComplete === false) {
      status = VERIFICATION_STATUS.UNVERIFIED;
    } else if (isAnomaly === true) {
      status = VERIFICATION_STATUS.CONFIRMED_ANOMALY;
    } else if (isAnomaly === false) {
      status = VERIFICATION_STATUS.FALSE_POSITIVE;
    } else {
      status = VERIFICATION_STATUS.UNVERIFIED;
    }
  }

  let reason = String(row[fields.reason] || defaultReason(status));
  if (status === VERIFICATION_STATUS.FALSE_POSITIVE && sourceComplete === false) {
    status = VERIFICATION_STATUS.UNVERIFIED;
    reason = "数据源不完整，不能将候选异常判为正常";
  }
  if (status === VERIFICATION_STATUS.FALSE_POSITIVE && confidence < minFalsePositiveConfidence) {
    status = VERIFICATION_STATUS.UNVERIFIED;
    reason = `正常结论置信度 ${confidence.toFixed(2)} 低于门槛 ${minFalsePositiveConfidence.toFixed(2)}`;
  }

  return {
    status,
    confidence,
    reason,
    evidence: standardizedEvidence({
      sourceComplete,
      dataQualityIssue,
      isAnomaly,
      observedValue: row[fields.observedValue],
      baselineLow: row[fields.baselineLow],
      baselineHigh: row[fields.baselineHigh],
    }, plan),
  };
}

function normalizeVerdict(value) {
  const text = String(value || "").trim().toLowerCase();
  const aliases = {
    anomaly: VERIFICATION_STATUS.CONFIRMED_ANOMALY,
    confirmed: VERIFICATION_STATUS.CONFIRMED_ANOMALY,
    confirmed_anomaly: VERIFICATION_STATUS.CONFIRMED_ANOMALY,
    normal: VERIFICATION_STATUS.FALSE_POSITIVE,
    false_positive: VERIFICATION_STATUS.FALSE_POSITIVE,
    data_issue: VERIFICATION_STATUS.DATA_QUALITY_ISSUE,
    data_quality_issue: VERIFICATION_STATUS.DATA_QUALITY_ISSUE,
    unknown: VERIFICATION_STATUS.UNVERIFIED,
    unverified: VERIFICATION_STATUS.UNVERIFIED,
  };
  return aliases[text] || null;
}

function standardizedEvidence(values, plan) {
  return {
    sourceComplete: values.sourceComplete ?? null,
    dataQualityIssue: values.dataQualityIssue ?? null,
    isAnomaly: values.isAnomaly ?? null,
    observedValue: normalizeScalar(values.observedValue),
    baselineLow: normalizeScalar(values.baselineLow),
    baselineHigh: normalizeScalar(values.baselineHigh),
    lineage: plan.sourceTables.map((table) => ({ table, role: "verification_source" })),
  };
}

function summarizeQueryEvidence(kind, sql, response = {}) {
  return {
    kind,
    sqlHash: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    traceId: response.traceId || null,
    rowCount: Number(response.rowCount ?? response.rows?.length ?? 0),
    durationMs: response.durationMs ?? null,
  };
}

function buildUnverifiedRecord(anomaly, plan, reason) {
  return {
    anomalyKey: anomalyKey(anomaly),
    planId: plan?.id || null,
    status: VERIFICATION_STATUS.UNVERIFIED,
    finalStatus: "anomaly",
    confidence: 0,
    reason,
    sourceTables: plan?.sourceTables || [],
    lineageStatus: plan?.sourceTables?.length ? "configured" : "missing",
    evidence: { queries: [] },
  };
}

function annotateAnomaly(anomaly, record) {
  return {
    ...anomaly,
    detectorStatus: "anomaly",
    verificationStatus: record.status,
    finalStatus: record.finalStatus,
    verificationConfidence: record.confidence,
    verificationReason: record.reason,
    verificationPlanId: record.planId,
    llmAnalysisStatus: record.llmAnalysis?.status || null,
    llmAnalysisSummary: record.llmAnalysis?.summary || null,
  };
}

function summarizeLlmAnalysis(records, config = {}) {
  const analyses = records.map((record) => record.llmAnalysis).filter(Boolean);
  return {
    enabled: config.enabled === true,
    provider: config.provider || "dashscope",
    model: config.model || "qwen3.6-plus",
    completedCount: analyses.filter((item) => item.status === "completed").length,
    unavailableCount: analyses.filter((item) => item.status === "unavailable").length,
    failedCount: analyses.filter((item) => item.status === "failed").length,
  };
}

function anomalyKey(anomaly) {
  return [
    anomaly.countryCode || "",
    anomaly.dashboardUuid || anomaly.dashboardTitle || "",
    anomaly.cardId || anomaly.cardTitle || "",
    anomaly.type || "",
    anomaly.context || "",
  ].join("::");
}

function countStatuses(records) {
  const counts = {
    [VERIFICATION_STATUS.CONFIRMED_ANOMALY]: 0,
    [VERIFICATION_STATUS.FALSE_POSITIVE]: 0,
    [VERIFICATION_STATUS.DATA_QUALITY_ISSUE]: 0,
    [VERIFICATION_STATUS.UNVERIFIED]: 0,
  };
  for (const record of records) {
    counts[record.status] = (counts[record.status] || 0) + 1;
  }
  return counts;
}

function sqlLiteral(value) {
  if (value === undefined || value === null || value === "") {
    return "NULL";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function toBoolean(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "yes", "y"].includes(text)) return true;
  if (["false", "no", "n"].includes(text)) return false;
  return null;
}

function clampConfidence(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeScalar(value) {
  return value === undefined ? null : value;
}

function defaultReason(status) {
  const reasons = {
    [VERIFICATION_STATUS.CONFIRMED_ANOMALY]: "数据库复核后仍确认异常",
    [VERIFICATION_STATUS.FALSE_POSITIVE]: "数据库复核后判定为正常波动",
    [VERIFICATION_STATUS.DATA_QUALITY_ISSUE]: "数据库复核发现数据链路或数据质量问题",
    [VERIFICATION_STATUS.UNVERIFIED]: "数据库证据不足，保留原异常",
  };
  return reasons[status] || reasons[VERIFICATION_STATUS.UNVERIFIED];
}

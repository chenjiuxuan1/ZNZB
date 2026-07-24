#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const inputPath = resolve(root, "config/public-check-result.ready.full.json");
const jsonOutputPath = resolve(root, "config/anomaly-verifier-evaluation.json");
const markdownOutputPath = resolve(root, "docs/anomaly-verifier-evaluation.md");
const srClient =
  process.env.SR_GATEWAY_CLIENT ??
  "/Users/miraliang/.codex/skills/sr-box/scripts/sr_gateway_client.py";

const datasourceByCountry = {
  INE: "sr_id_local",
  PH: "sr_ph_local",
  TH: "sr_th_local",
  PK: "sr_pk_local",
  MX: "sr_mx_local",
};

const metricColumn = {
  入催率: "d0",
  D1: "d1",
  D3: "d3",
  D7: "d7",
  展期率: "extension_rate",
  老客D3逾期率: "d3",
};

const conversionMetricColumn = {
  注册数: "register_cnt",
  正审进件: "freeze_cnt",
  正审通过: "pass_cnt",
  放款: "grant_cnt",
};

function parseAnomaly(anomaly, index) {
  const message = anomaly.message ?? "";
  const metric = message.match(/指标「([^」]+)」/)?.[1] ?? null;
  const dates = message.match(
    /(?:统计日期|注册日期|放款日期|到期日期|stat_date)\s+(\d{4}-\d{2}-\d{2})\s+对比\s+(\d{4}-\d{2}-\d{2})/,
  );
  const percentValues = message.match(
    /从\s+([+-]?\d+(?:\.\d+)?)%\s+到\s+([+-]?\d+(?:\.\d+)?)%/,
  );
  const numericValues = message.match(
    /从\s+([+-]?\d+(?:\.\d+)?)\s+到\s+([+-]?\d+(?:\.\d+)?)/,
  );
  const dimension = message.match(/，(APP|产品期限|Applist_Level)=([^，）]+)[，）]/);
  const granularity =
    metric === "老客D3逾期率"
      ? "old_user"
      : anomaly.cardTitle?.includes("分APP")
        ? "app"
        : anomaly.cardTitle?.includes("分产品") ||
            anomaly.cardTitle?.includes("分期限")
          ? "product"
          : "overall";

  const oldPrevious = percentValues
    ? Number(percentValues[1]) / 100
    : numericValues
      ? Number(numericValues[1])
      : null;
  const oldCurrent = percentValues
    ? Number(percentValues[2]) / 100
    : numericValues
      ? Number(numericValues[2])
      : null;

  return {
    ...anomaly,
    originalIndex: index,
    metric,
    currentDate: dates?.[1] ?? null,
    previousDate: dates?.[2] ?? null,
    oldPrevious,
    oldCurrent,
    dimensionName: dimension?.[1] ?? null,
    dimensionValue: dimension?.[2] ?? null,
    granularity,
  };
}

function semanticKey(anomaly) {
  return [
    anomaly.countryCode,
    anomaly.type,
    anomaly.metric ?? anomaly.cardTitle,
    anomaly.currentDate ?? "",
    anomaly.previousDate ?? "",
    anomaly.granularity,
    (anomaly.dimensionValue ?? "").toLowerCase(),
    anomaly.oldPrevious ?? "",
    anomaly.oldCurrent ?? "",
  ].join("|");
}

function canonicalScore(anomaly) {
  let score = 0;
  if (anomaly.context?.includes("到期日期")) score += 20;
  if (anomaly.cardTitle?.includes("明细")) score += 5;
  if (anomaly.cardTitle?.includes("表")) score += 2;
  return score;
}

function groupSemantically(anomalies) {
  const groups = new Map();
  for (const anomaly of anomalies) {
    const key = semanticKey(anomaly);
    const group = groups.get(key) ?? [];
    group.push(anomaly);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    members: members.sort((a, b) => canonicalScore(a) - canonicalScore(b)),
  }));
}

function buildOverdueSql(minDate, maxDate) {
  const metrics = `
    ROUND(SUM(D0_overdue) / NULLIF(SUM(D0_avaliable), 0), 8) AS d0,
    ROUND(SUM(D1_overdue) / NULLIF(SUM(D1_avaliable), 0), 8) AS d1,
    ROUND(SUM(D3_overdue) / NULLIF(SUM(D3_avaliable), 0), 8) AS d3,
    ROUND(SUM(D7_overdue) / NULLIF(SUM(D7_avaliable), 0), 8) AS d7,
    ROUND(SUM(delay_cnt) / NULLIF(SUM(stat_cnt), 0), 8) AS extension_rate`;
  const where = `
    FROM ads.ads_vintage_every_period_overdue_data
    WHERE stat_type = '金额'
      AND period_seq = 1
      AND grant_day BETWEEN '${minDate}' AND '${maxDate}'`;

  return `
SELECT 'overall' AS granularity, CAST(grant_day AS VARCHAR) AS stat_date,
       '__overall__' AS dim_value, ${metrics}
${where}
GROUP BY 1, 2, 3
UNION ALL
SELECT 'app' AS granularity, CAST(grant_day AS VARCHAR) AS stat_date,
       LOWER(COALESCE(app, '')) AS dim_value, ${metrics}
${where}
GROUP BY 1, 2, 3
UNION ALL
SELECT 'product' AS granularity, CAST(grant_day AS VARCHAR) AS stat_date,
       LOWER(COALESCE(product_period, '')) AS dim_value, ${metrics}
${where}
GROUP BY 1, 2, 3
UNION ALL
SELECT 'old_user' AS granularity, CAST(grant_day AS VARCHAR) AS stat_date,
       '__overall__' AS dim_value, ${metrics}
${where}
  AND user_debt_status = 'old_user'
GROUP BY 1, 2, 3
LIMIT 5000`.trim();
}

async function queryCountry(countryCode, minDate, maxDate) {
  const datasource = datasourceByCountry[countryCode];
  const sql = buildOverdueSql(minDate, maxDate);
  const { stdout } = await execFile(
    "python3",
    [
      srClient,
      "datasource-execute",
      "--datasource",
      datasource,
      "--page-size",
      "500",
      "--timeout-sec",
      "120",
      "--sql",
      sql,
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout);
  if (!response.success || !response.data?.completed) {
    throw new Error(`${countryCode} query did not complete`);
  }
  return {
    kind: "overdue",
    countryCode,
    datasource,
    traceId: response.traceId,
    executedAt: response.data.executedAt,
    rowCount: response.data.rows?.length ?? 0,
    rows: response.data.rows ?? [],
  };
}

async function queryConversionCountry(countryCode, minDate, maxDate) {
  const datasource = datasourceByCountry[countryCode];
  const sql = `
SELECT CAST(register_date AS VARCHAR) AS stat_date,
       LOWER(COALESCE(from_source, '')) AS app,
       SUM(register_cnt) AS register_cnt,
       SUM(first_freeze_cnt) AS freeze_cnt,
       SUM(first_pass_cnt) AS pass_cnt,
       SUM(first_grant_cnt) AS grant_cnt
FROM dws.dws_user_register_to_grant
WHERE register_date BETWEEN '${minDate}' AND '${maxDate}'
GROUP BY 1, 2
LIMIT 1000`.trim();
  const { stdout } = await execFile(
    "python3",
    [
      srClient,
      "datasource-execute",
      "--datasource",
      datasource,
      "--page-size",
      "500",
      "--timeout-sec",
      "120",
      "--sql",
      sql,
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  const response = JSON.parse(stdout);
  if (!response.success || !response.data?.completed) {
    throw new Error(`${countryCode} conversion query did not complete`);
  }
  return {
    kind: "conversion",
    countryCode,
    datasource,
    traceId: response.traceId,
    executedAt: response.data.executedAt,
    rowCount: response.data.rows?.length ?? 0,
    rows: response.data.rows ?? [],
  };
}

function databaseIndex(queryResults) {
  const index = new Map();
  for (const result of queryResults) {
    for (const row of result.rows) {
      const key = [
        result.countryCode,
        row.granularity,
        row.stat_date,
        String(row.dim_value).toLowerCase(),
      ].join("|");
      index.set(key, row);
      // 印尼展示卡片会隐藏 product_period 最后一段费率，例如
      // 120天_5期_40%_10% 在报表中显示为 120天_5期_40%。
      if (
        result.countryCode === "INE" &&
        row.granularity === "product" &&
        (String(row.dim_value).match(/%/g)?.length ?? 0) >= 2
      ) {
        const displayDimension = String(row.dim_value)
          .replace(/_\d+(?:\.\d+)?%$/, "")
          .toLowerCase();
        index.set(
          [
            result.countryCode,
            row.granularity,
            row.stat_date,
            displayDimension,
          ].join("|"),
          row,
        );
      }
    }
  }
  return index;
}

function conversionDatabaseIndex(queryResults) {
  const index = new Map();
  for (const result of queryResults.filter(
    (query) => query.kind === "conversion",
  )) {
    for (const row of result.rows) {
      index.set(
        [result.countryCode, row.stat_date, String(row.app).toLowerCase()].join(
          "|",
        ),
        row,
      );
    }
  }
  return index;
}

function roundPercent(value) {
  return value === null || value === undefined
    ? null
    : Math.round(Number(value) * 10000) / 100;
}

function classifyOverdue(canonical, currentIndex) {
  const dim =
    ["overall", "old_user"].includes(canonical.granularity)
      ? "__overall__"
      : (canonical.dimensionValue ?? "").toLowerCase();
  const previousKey = [
    canonical.countryCode,
    canonical.granularity,
    canonical.previousDate,
    dim,
  ].join("|");
  const currentKey = [
    canonical.countryCode,
    canonical.granularity,
    canonical.currentDate,
    dim,
  ].join("|");
  const previousRow = currentIndex.get(previousKey);
  const currentRow = currentIndex.get(currentKey);
  const column = metricColumn[canonical.metric];
  const dbPrevious = previousRow?.[column];
  const dbCurrent = currentRow?.[column];

  if (
    dbPrevious === undefined ||
    dbPrevious === null ||
    dbCurrent === undefined ||
    dbCurrent === null
  ) {
    return {
      label: "unverified_missing_data",
      reason: "重算结果中缺少历史日期、维度或指标值",
      evidence: { previousKey, currentKey, column },
    };
  }

  const previous = Number(dbPrevious);
  const current = Number(dbCurrent);
  const currentDelta = current - previous;
  const originalDelta = canonical.oldCurrent - canonical.oldPrevious;
  const displayTolerance = 0.006;
  const oldValuesStillMatch =
    Math.abs(previous - canonical.oldPrevious) <= displayTolerance &&
    Math.abs(current - canonical.oldCurrent) <= displayTolerance;
  const threshold = ["overall", "old_user"].includes(canonical.granularity)
    ? 0.1
    : 0.05;
  const directionChanged =
    Math.sign(currentDelta) !== 0 &&
    Math.sign(originalDelta) !== 0 &&
    Math.sign(currentDelta) !== Math.sign(originalDelta);

  const evidence = {
    thresholdPercentagePoints: threshold * 100,
    historicalAlert: {
      previousPercent: roundPercent(canonical.oldPrevious),
      currentPercent: roundPercent(canonical.oldCurrent),
      deltaPercentagePoints: roundPercent(originalDelta),
    },
    databaseRecalculation: {
      previousPercent: roundPercent(previous),
      currentPercent: roundPercent(current),
      deltaPercentagePoints: roundPercent(currentDelta),
    },
    oldValuesStillMatch,
  };

  if (oldValuesStillMatch) {
    return {
      label: "confirmed_anomaly",
      reason: "下游表重算与历史告警值一致",
      evidence,
    };
  }
  if (Math.abs(currentDelta) < threshold) {
    return {
      label: "false_positive",
      reason: "数据回补后波动已低于同粒度告警阈值",
      evidence,
    };
  }
  if (directionChanged) {
    return {
      label: "data_changed_direction",
      reason: "数据回补后仍有大幅波动，但方向与历史告警相反",
      evidence,
    };
  }
  return {
    label: "confirmed_anomaly_updated",
    reason: "数据回补改写了数值，但重算后仍超过告警阈值",
    evidence,
  };
}

function classifyConversion(canonical, currentIndex) {
  const previousRow = currentIndex.get(
    [
      canonical.countryCode,
      canonical.previousDate,
      canonical.dimensionValue?.toLowerCase(),
    ].join("|"),
  );
  const currentRow = currentIndex.get(
    [
      canonical.countryCode,
      canonical.currentDate,
      canonical.dimensionValue?.toLowerCase(),
    ].join("|"),
  );
  const column = conversionMetricColumn[canonical.metric];
  if (!previousRow || !currentRow || !column) {
    return {
      label: "unverified_missing_data",
      reason: "转化宽表中缺少历史日期、APP 或指标值",
    };
  }

  let previous = Number(previousRow[column]);
  let current = Number(currentRow[column]);
  // 菲律宾卡片的“正审进件”展示为注册到正审进件的转化百分比。
  if (canonical.countryCode === "PH" && canonical.metric === "正审进件") {
    previous = (previous / Number(previousRow.register_cnt)) * 100;
    current = (current / Number(currentRow.register_cnt)) * 100;
  }
  const currentRate =
    previous === 0 ? (current === 0 ? 0 : Number.POSITIVE_INFINITY) : (current - previous) / previous;
  const originalRate =
    canonical.oldPrevious === 0
      ? canonical.oldCurrent === 0
        ? 0
        : Number.POSITIVE_INFINITY
      : (canonical.oldCurrent - canonical.oldPrevious) / canonical.oldPrevious;
  const outsideThreshold = currentRate < -0.25 || currentRate > 0.4;
  const directionChanged =
    Number.isFinite(currentRate) &&
    Number.isFinite(originalRate) &&
    Math.sign(currentRate) !== 0 &&
    Math.sign(originalRate) !== 0 &&
    Math.sign(currentRate) !== Math.sign(originalRate);
  const evidence = {
    thresholds: { maxDropRatePercent: 25, maxRiseRatePercent: 40 },
    historicalAlert: {
      previous: canonical.oldPrevious,
      current: canonical.oldCurrent,
      relativeChangePercent: Number.isFinite(originalRate)
        ? Math.round(originalRate * 1000) / 10
        : null,
    },
    databaseRecalculation: {
      previous: Math.round(previous * 10000) / 10000,
      current: Math.round(current * 10000) / 10000,
      relativeChangePercent: Number.isFinite(currentRate)
        ? Math.round(currentRate * 1000) / 10
        : null,
    },
  };

  if (!outsideThreshold) {
    return {
      label: "false_positive",
      reason: "转化宽表重算后的相对波动已低于历史规则阈值",
      evidence,
    };
  }
  if (directionChanged) {
    return {
      label: "data_changed_direction",
      reason: "转化数据回补后仍有大幅波动，但方向与历史告警相反",
      evidence,
    };
  }
  if (
    Number.isFinite(currentRate) &&
    Number.isFinite(originalRate) &&
    Math.abs(currentRate - originalRate) <= 0.05
  ) {
    return {
      label: "confirmed_anomaly",
      reason: "转化宽表重算的波动方向和幅度与历史告警一致",
      evidence,
    };
  }
  return {
    label: "confirmed_anomaly_updated",
    reason: "转化数据发生回补，但重算后仍超过历史规则阈值",
    evidence,
  };
}

function fallbackClassification(canonical) {
  if (canonical.type === "requiredDatePresent") {
    if (
      ["PH", "PK"].includes(canonical.countryCode) &&
      canonical.message?.includes("缺少 D0")
    ) {
      return {
        label: "false_positive_config",
        reason:
          "历史规则按 D0 检查，但当前国家配置已明确为 D-1 更新；这是更新节奏配置误判",
        evidence: {
          historicalExpectation: "D0",
          correctedExpectation: "D-1",
        },
      };
    }
    return {
      label: "late_arrival_check_required",
      reason: "缺数告警必须在对应业务表检查到数时间，不能在两个月后按波动重算",
    };
  }
  if (
    canonical.type === "intradayProgress" ||
    canonical.type === "intradaySameTimeChange"
  ) {
    return {
      label: "point_in_time_unverifiable",
      reason: "盘中告警依赖触发时刻快照，当前数据库无法还原当时进度",
    };
  }
  return {
    label: "unsupported_metric",
    reason: "该指标不在逾期率标准模型中，需要补充对应下游表核验计划",
  };
}

function countBy(items, selector) {
  const result = {};
  for (const item of items) {
    const key = selector(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function markdownReport(report) {
  const semanticCounts = Object.entries(report.summary.semanticLabels)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `| ${label} | ${count} |`)
    .join("\n");
  const countryCounts = Object.entries(report.summary.falsePositivesByCountry)
    .map(([country, count]) => `| ${country} | ${count} |`)
    .join("\n");
  const falseRows = report.falsePositives
    .map((item) => {
      const isPercentagePoint =
        item.evidence?.historicalAlert?.deltaPercentagePoints !== undefined;
      const historicalChange = isPercentagePoint
        ? item.evidence?.historicalAlert?.deltaPercentagePoints
        : item.evidence?.historicalAlert?.relativeChangePercent;
      const currentChange = isPercentagePoint
        ? item.evidence?.databaseRecalculation?.deltaPercentagePoints
        : item.evidence?.databaseRecalculation?.relativeChangePercent;
      const unit = isPercentagePoint ? "pp" : "%";
      return `| ${item.countryCode} | ${item.cardTitle} | ${item.metric ?? item.type} | ${item.currentDate && item.previousDate ? `${item.currentDate} vs ${item.previousDate}` : "更新节奏"} | ${item.dimensionValue ?? "整体"} | ${historicalChange ?? item.evidence?.historicalExpectation ?? "-"}${typeof historicalChange === "number" ? unit : ""} | ${currentChange ?? item.evidence?.correctedExpectation ?? "-"}${typeof currentChange === "number" ? unit : ""} | ${item.duplicateAlertCount} |`;
    })
    .join("\n");
  const changedDirectionRows = report.dataChangedDirection
    .map(
      (item) =>
        `| ${item.countryCode} | ${item.cardTitle} | ${item.metric} | ${item.dimensionValue ?? "整体"} | ${item.evidence.historicalAlert.deltaPercentagePoints}pp | ${item.evidence.databaseRecalculation.deltaPercentagePoints}pp |`,
    )
    .join("\n");
  const traces = report.queries
    .map(
      (query) =>
        `| ${query.countryCode} | ${query.datasource} | ${query.rowCount} | \`${query.traceId}\` |`,
    )
    .join("\n");

  return `# 历史异常下游复核报告

- 历史检查时间：${report.sourceCheckedAt}
- 复核时间：${report.evaluatedAt}
- 原始告警：${report.summary.rawAlerts} 条
- 语义去重后：${report.summary.semanticAlerts} 条
- 重复展示告警：${report.summary.duplicateAlerts} 条
- 可用标准逾期模型重算：${report.summary.overdueVerified} 条语义告警
- 可用转化宽表重算：${report.summary.conversionVerified} 条语义告警
- 确认误判：${report.summary.falsePositives} 条语义告警

## 语义告警标签

| 标签 | 数量 |
|---|---:|
${semanticCounts}

## 误判分布

| 国家 | 误判数 |
|---|---:|
${countryCounts || "| - | 0 |"}

## 误判明细

历史值与当前下游表重算值允许 0.6 个百分点的展示舍入差。整体阈值为 10pp，APP/产品维度阈值为 5pp。

| 国家 | 卡片 | 指标 | 日期 | 维度 | 原告警变化 | 当前重算变化 | 同义重复数 |
|---|---|---|---|---|---:|---:|---:|
${falseRows || "| - | - | - | - | - | - | - | - |"}

## 数据回补后方向反转

这类不能直接标正常：原告警数值已失效，但当前仍存在反方向的大幅波动，应标为数据质量/回补问题。

| 国家 | 卡片 | 指标 | 维度 | 原告警变化 | 当前重算变化 |
|---|---|---|---|---:|---:|
${changedDirectionRows || "| - | - | - | - | - | - |"}

## 查询证据

| 国家 | 数据源 | 返回行数 | SR Box traceId |
|---|---|---:|---|
${traces}

## 口径说明

- 重复告警：忽略卡片展示形式以及“放款日期/到期日期”重复上下文后，业务键完全相同的告警。
- confirmed_anomaly：下游 ADS 标准模型重算仍与历史告警数值一致。
- confirmed_anomaly_updated：发生过回补，但重算后仍超过阈值。
- false_positive：发生过回补，重算后的波动已经低于同粒度阈值，可标为正常。
- data_changed_direction：发生过回补且当前方向相反，不能标正常。
- unsupported_metric / point_in_time_unverifiable / late_arrival_check_required：尚未配置对应下游表或无法从当前快照还原，不能冒充已验证。
`;
}

async function main() {
  const source = JSON.parse(await readFile(inputPath, "utf8"));
  const parsed = source.anomalies.map(parseAnomaly);
  const groups = groupSemantically(parsed);
  const overdueGroups = groups.filter(
    ({ members: [canonical] }) =>
      canonical.type === "completeDayChange" &&
      metricColumn[canonical.metric] &&
      canonical.currentDate &&
      canonical.previousDate,
  );
  const conversionGroups = groups.filter(
    ({ members: [canonical] }) =>
      canonical.type === "completeDayChange" &&
      conversionMetricColumn[canonical.metric] &&
      canonical.currentDate &&
      canonical.previousDate &&
      canonical.dimensionValue,
  );

  const datesByCountry = new Map();
  for (const { members: [canonical] } of overdueGroups) {
    const dates = datesByCountry.get(canonical.countryCode) ?? [];
    dates.push(canonical.currentDate, canonical.previousDate);
    datesByCountry.set(canonical.countryCode, dates);
  }

  const queries = await Promise.all(
    [...datesByCountry.entries()].map(([countryCode, dates]) =>
      queryCountry(countryCode, dates.sort()[0], dates.sort().at(-1)),
    ),
  );
  const conversionDatesByCountry = new Map();
  for (const { members: [canonical] } of conversionGroups) {
    const dates = conversionDatesByCountry.get(canonical.countryCode) ?? [];
    dates.push(canonical.currentDate, canonical.previousDate);
    conversionDatesByCountry.set(canonical.countryCode, dates);
  }
  queries.push(
    ...(await Promise.all(
      [...conversionDatesByCountry.entries()].map(([countryCode, dates]) =>
        queryConversionCountry(countryCode, dates.sort()[0], dates.sort().at(-1)),
      ),
    )),
  );
  const currentIndex = databaseIndex(queries);
  const conversionIndex = conversionDatabaseIndex(queries);
  const semanticResults = groups.map((group) => {
    const canonical = group.members[0];
    const classification =
      canonical.type === "completeDayChange" &&
      metricColumn[canonical.metric] &&
      canonical.currentDate &&
      canonical.previousDate
        ? classifyOverdue(canonical, currentIndex)
        : canonical.type === "completeDayChange" &&
            conversionMetricColumn[canonical.metric] &&
            canonical.currentDate &&
            canonical.previousDate &&
            canonical.dimensionValue
          ? classifyConversion(canonical, conversionIndex)
        : fallbackClassification(canonical);
    return {
      semanticKey: group.key,
      countryCode: canonical.countryCode,
      countryName: canonical.countryName,
      cardId: canonical.cardId,
      cardTitle: canonical.cardTitle,
      dashboardTitle: canonical.dashboardTitle,
      type: canonical.type,
      metric: canonical.metric,
      currentDate: canonical.currentDate,
      previousDate: canonical.previousDate,
      granularity: canonical.granularity,
      dimensionValue: canonical.dimensionValue,
      context: canonical.context,
      originalMessage: canonical.message,
      duplicateAlertCount: group.members.length - 1,
      rawAlertIndices: group.members.map((member) => member.originalIndex),
      ...classification,
    };
  });

  const rawResults = [];
  for (const semantic of semanticResults) {
    semantic.rawAlertIndices.forEach((originalIndex, memberIndex) => {
      rawResults.push({
        originalIndex,
        semanticKey: semantic.semanticKey,
        label: memberIndex === 0 ? semantic.label : "duplicate_alert",
        canonicalLabel: semantic.label,
      });
    });
  }
  rawResults.sort((a, b) => a.originalIndex - b.originalIndex);

  const falsePositives = semanticResults.filter((item) =>
    item.label.startsWith("false_positive"),
  );
  const report = {
    evaluatedAt: new Date().toISOString(),
    sourceFile: "config/public-check-result.ready.full.json",
    sourceCheckedAt: source.checkedAt,
    methodology: {
      semanticDeduplication:
        "country + type + metric + date pair + business granularity + dimension + displayed values",
      sourceTable: "ads.ads_vintage_every_period_overdue_data",
      statType: "金额",
      periodSeq: 1,
      historicalValueTolerancePercentagePoints: 0.6,
      overallThresholdPercentagePoints: 10,
      dimensionThresholdPercentagePoints: 5,
    },
    summary: {
      rawAlerts: parsed.length,
      semanticAlerts: semanticResults.length,
      duplicateAlerts: parsed.length - semanticResults.length,
      overdueVerified: semanticResults.filter((item) =>
        metricColumn[item.metric] &&
        [
          "confirmed_anomaly",
          "confirmed_anomaly_updated",
          "false_positive",
          "data_changed_direction",
        ].includes(item.label),
      ).length,
      conversionVerified: semanticResults.filter((item) =>
        conversionMetricColumn[item.metric] &&
        [
          "confirmed_anomaly",
          "confirmed_anomaly_updated",
          "false_positive",
          "data_changed_direction",
        ].includes(item.label),
      ).length,
      falsePositives: falsePositives.length,
      rawLabels: countBy(rawResults, (item) => item.label),
      semanticLabels: countBy(semanticResults, (item) => item.label),
      falsePositivesByCountry: countBy(
        falsePositives,
        (item) => item.countryCode,
      ),
    },
    queries: queries.map(({ rows: _rows, ...query }) => query),
    falsePositives,
    dataChangedDirection: semanticResults.filter(
      (item) => item.label === "data_changed_direction",
    ),
    semanticResults,
    rawResults,
  };

  await writeFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownOutputPath, markdownReport(report));
  console.log(
    JSON.stringify(
      {
        jsonOutputPath,
        markdownOutputPath,
        summary: report.summary,
        queries: report.queries,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

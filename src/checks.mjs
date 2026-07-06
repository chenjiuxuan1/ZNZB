import { buildDashboardLink, findPanel, panelTextList } from "./dashboard.mjs";
import { formatTimestamp } from "./utils.mjs";
import { selectSeries } from "./frame-data.mjs";

export function evaluateAnomalies({ config, dashboard, panels, snapshots, nowMs }) {
  const anomalies = [];

  for (const panel of panels) {
    const snapshot = snapshots.get(panel.id);
    if (!snapshot) {
      continue;
    }

    if (config.builtInChecks?.queryError !== false) {
      for (const errorMessage of snapshot.queryErrors) {
        anomalies.push(buildAnomaly(config, panel, "queryError", `查询失败: ${errorMessage}`));
      }
    }

    if (config.builtInChecks?.noData !== false && !snapshot.hasData) {
      anomalies.push(buildAnomaly(config, panel, "noData", "面板返回空数据"));
    }
  }

  for (const rule of config.rules) {
    const panel = findPanel(panels, rule);
    if (!panel) {
      anomalies.push({
        key: `config:${rule.panelId || rule.panelTitle || "unknown"}`,
        severity: "error",
        message: `规则未匹配到面板: ${rule.panelId || rule.panelTitle || "unknown"}`,
        fingerprint: `config:${rule.panelId || rule.panelTitle || "unknown"}`,
      });
      continue;
    }

    const snapshot = snapshots.get(panel.id);
    if (!snapshot) {
      continue;
    }

    const anomaly = runRule(config, panel, snapshot, rule, nowMs);
    if (anomaly) {
      anomalies.push(anomaly);
    }
  }

  return {
    dashboardTitle: dashboard.title,
    dashboardUid: dashboard.uid,
    anomalies,
  };
}

function runRule(config, panel, snapshot, rule, nowMs) {
  switch (rule.type) {
    case "noData":
      return snapshot.hasData
        ? null
        : buildAnomaly(config, panel, rule.type, "命中 noData 规则");
    case "latestValueOutsideRange":
      return checkLatestValueOutsideRange(config, panel, snapshot, rule);
    case "changeRateOutsideRange":
      return checkChangeRateOutsideRange(config, panel, snapshot, rule);
    case "staleLatestTimestamp":
      return checkStaleTimestamp(config, panel, snapshot, rule, nowMs);
    case "tableRowCountOutsideRange":
      return checkRowCount(config, panel, snapshot, rule);
    case "textMissing":
      return checkTextMissing(config, panel, snapshot, rule);
    case "textPresent":
      return checkTextPresent(config, panel, snapshot, rule);
    default:
      return buildAnomaly(config, panel, "unsupportedRule", `不支持的规则类型: ${rule.type}`);
  }
}

function checkLatestValueOutsideRange(config, panel, snapshot, rule) {
  const series = selectSeries(snapshot, rule);
  if (!series) {
    return buildAnomaly(config, panel, rule.type, "未找到可比较的数值序列");
  }

  if (rule.min !== undefined && series.latestValue < rule.min) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `${series.fieldName} 最新值 ${series.latestValue} 小于下限 ${rule.min}`,
    );
  }

  if (rule.max !== undefined && series.latestValue > rule.max) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `${series.fieldName} 最新值 ${series.latestValue} 大于上限 ${rule.max}`,
    );
  }

  return null;
}

function checkChangeRateOutsideRange(config, panel, snapshot, rule) {
  const series = selectSeries(snapshot, rule);
  if (!series || series.previousValue === null || series.previousValue === 0) {
    return buildAnomaly(config, panel, rule.type, "无法计算变化率");
  }

  const changeRate = (series.latestValue - series.previousValue) / Math.abs(series.previousValue);

  if (rule.min !== undefined && changeRate < rule.min) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `${series.fieldName} 变化率 ${changeRate.toFixed(4)} 小于下限 ${rule.min}`,
    );
  }

  if (rule.max !== undefined && changeRate > rule.max) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `${series.fieldName} 变化率 ${changeRate.toFixed(4)} 大于上限 ${rule.max}`,
    );
  }

  return null;
}

function checkStaleTimestamp(config, panel, snapshot, rule, nowMs) {
  if (!snapshot.latestTimestamp) {
    return buildAnomaly(config, panel, rule.type, "没有时间戳可用于新鲜度判断");
  }

  const ageMinutes = (nowMs - snapshot.latestTimestamp) / 60_000;
  if (ageMinutes > rule.maxAgeMinutes) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `最新时间 ${formatTimestamp(snapshot.latestTimestamp)}，已滞后 ${ageMinutes.toFixed(1)} 分钟`,
    );
  }

  return null;
}

function checkRowCount(config, panel, snapshot, rule) {
  if (rule.min !== undefined && snapshot.rowCount < rule.min) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `表格行数 ${snapshot.rowCount} 小于下限 ${rule.min}`,
    );
  }

  if (rule.max !== undefined && snapshot.rowCount > rule.max) {
    return buildAnomaly(
      config,
      panel,
      rule.type,
      `表格行数 ${snapshot.rowCount} 大于上限 ${rule.max}`,
    );
  }

  return null;
}

function checkTextMissing(config, panel, snapshot, rule) {
  const text = panelTextList(snapshot).join("\n");
  if (matchesText(text, rule)) {
    return null;
  }

  return buildAnomaly(
    config,
    panel,
    rule.type,
    `未找到预期文本: ${rule.contains || rule.pattern}`,
  );
}

function checkTextPresent(config, panel, snapshot, rule) {
  const text = panelTextList(snapshot).join("\n");
  if (!matchesText(text, rule)) {
    return null;
  }

  return buildAnomaly(
    config,
    panel,
    rule.type,
    `发现异常文本: ${rule.contains || rule.pattern}`,
  );
}

function matchesText(text, rule) {
  if (rule.contains) {
    return text.includes(rule.contains);
  }

  if (rule.pattern) {
    return new RegExp(rule.pattern).test(text);
  }

  return false;
}

function buildAnomaly(config, panel, type, message) {
  const link = buildDashboardLink(config, panel);
  return {
    key: `${panel.id}:${type}:${message}`,
    severity: "error",
    panelId: panel.id,
    panelTitle: panel.title || `Panel ${panel.id}`,
    type,
    link,
    message,
    fingerprint: `${panel.id}:${type}:${message}`,
  };
}


export async function notify(config, payload) {
  const message = buildMessage(payload);
  return notifyText(config, message, {
    title: `${payload.dashboardTitle || "报表"}巡检告警`,
    severity: payload.newAnomalies?.length > 0 ? "warning" : "info",
  });
}

export async function notifyPublicCheck(config, result) {
  const alertCount = getPublicAlertCount(result);
  if (alertCount === 0 && config.alerts?.sendWhenHealthy === false) {
    return { sent: false, reason: "healthy notification disabled" };
  }

  const messages = buildPublicCheckMessages(result, config.alerts || {});
  const results = [];

  for (const message of messages) {
    results.push(
      await notifyText(config, message.body, {
        title: message.title,
        severity: alertCount > 0 ? "warning" : "info",
        timestamp: result.checkedAt,
        anomalyCount: message.anomalyCount ?? alertCount,
        checkedCardCount: result.checkedCardCount,
      }),
    );
  }

  return {
    sent: results.some((resultItem) => resultItem.sent),
    sentMessages: messages.length,
    results,
  };
}

export async function notifyText(config, message, metadata = {}) {
  console.log(message);

  const { channel, webhookUrl } = config.alerts || {};
  const normalizedChannel = normalizeAlertChannel(channel);
  if (normalizedChannel === "knBot") {
    return notifyKnBot(config.alerts || {}, message);
  }

  const resolvedWebhookUrl = resolveEnvString(webhookUrl);
  if (!normalizedChannel || normalizedChannel === "console" || !resolvedWebhookUrl) {
    return { sent: false, reason: "webhook not configured" };
  }

  const body = buildWebhookPayload(normalizedChannel, message, metadata, config.alerts || {});
  const response = await fetchWithRetry(resolvedWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `Alert webhook failed (${response.status} ${response.statusText}): ${responseText.slice(0, 240)}`,
    );
  }

  return { sent: true, status: response.status };
}

async function notifyKnBot(alertConfig, message) {
  const botToken = resolveEnvString(alertConfig.botToken || alertConfig.token);
  const apiBaseUrl = resolveEnvString(alertConfig.botApiBaseUrl || "https://bot.kn.chat").replace(/\/+$/, "");
  const directChatIds = normalizeChatIds(alertConfig.chatIds || alertConfig.chatId);
  const resolvedChatIds = await resolveKnBotEmailChatIds({
    apiBaseUrl,
    botToken,
    emails: alertConfig.recipientEmails || alertConfig.emails,
  });
  const chatIds = [...new Set([...directChatIds, ...resolvedChatIds])];
  if (!botToken || chatIds.length === 0) {
    return { sent: false, reason: "kn bot not configured" };
  }

  const url = `${apiBaseUrl}/bot${botToken}/sendMessage`;
  const text = appendMentionText(message, alertConfig.mentions);
  const results = [];

  for (const chatId of chatIds) {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `KN Chat Bot sendMessage failed (${response.status} ${response.statusText}): ${responseText.slice(0, 240)}`,
      );
    }

    results.push({ chatId, status: response.status });
  }

  return {
    sent: results.length > 0,
    status: results[0]?.status || 200,
    chatIds,
    results,
  };
}

async function resolveKnBotEmailChatIds({ apiBaseUrl, botToken, emails }) {
  if (!botToken) {
    return [];
  }

  const normalizedEmails = normalizeEmailRecipients(emails);
  if (normalizedEmails.length === 0) {
    return [];
  }

  const url = `${apiBaseUrl}/bot${botToken}/resolveUserId`;
  const chatIds = [];
  for (const email of normalizedEmails) {
    const form = new URLSearchParams();
    form.set("email", email);
    const response = await fetchWithRetry(url, {
      method: "POST",
      body: form,
    });
    const responseText = await response.text().catch(() => "");
    let responseJson = {};
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = {};
    }
    if (!response.ok || responseJson.ok === false || !responseJson.result?.user_id) {
      throw new Error(
        `KN Chat Bot resolveUserId failed for ${email} (${response.status} ${response.statusText}): ${responseText.slice(0, 240)}`,
      );
    }
    chatIds.push(String(responseJson.result.user_id));
  }

  return chatIds;
}

async function fetchWithRetry(url, options, retries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      await delay(500 * attempt);
    }
  }

  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildMessage(payload) {
  const lines = [];

  lines.push(`[值班机器人] ${payload.dashboardTitle}`);

  if (payload.newAnomalies.length > 0) {
    lines.push("");
    lines.push("新异常:");
    for (const anomaly of payload.newAnomalies) {
      lines.push(`- ${anomaly.panelTitle}: ${anomaly.message}`);
      if (anomaly.link) {
        lines.push(`  ${anomaly.link}`);
      }
    }
  }

  if (payload.recoveries.length > 0) {
    lines.push("");
    lines.push("已恢复:");
    for (const recovery of payload.recoveries) {
      lines.push(`- ${recovery.panelTitle}: ${recovery.message}`);
    }
  }

  if (payload.newAnomalies.length === 0 && payload.recoveries.length === 0) {
    lines.push("");
    lines.push("本轮无新异常。");
  }

  return lines.join("\n");
}

export function buildPublicCheckMessage(result, options = {}) {
  return buildPublicCheckMessages(result, options)
    .map((message) => message.body)
    .join("\n\n");
}

export function buildPublicCheckMessages(result, options = {}) {
  const anomalies = result.anomalies || [];
  const { missingAnomalies, fluctuationAnomalies } = classifyPublicAnomalies(anomalies);
  const countryGroups = groupAnomaliesByCountry(anomalies);
  const messages = [];
  const alertCount = getPublicAlertCount(result);

  messages.push({
    title: alertCount > 0 ? `公共报表巡检异常 ${alertCount} 条` : "公共报表巡检正常",
    body: buildPublicCheckSummaryMessage(result, missingAnomalies, fluctuationAnomalies, countryGroups, options),
    anomalyCount: alertCount,
  });

  if (anomalies.length === 0) {
    return messages;
  }

  for (const group of countryGroups) {
    messages.push({
      title: `${group.label} 公共报表巡检异常 ${group.anomalies.length} 条`,
      body: buildCountryPublicCheckMessage(result, group, options),
      anomalyCount: group.anomalies.length,
    });
  }

  return messages;
}

function buildPublicCheckSummaryMessage(result, missingAnomalies, fluctuationAnomalies, countryGroups, options = {}) {
  const anomalies = result.anomalies || [];
  const detailUrl = normalizeDetailUrl(options.detailUrl);
  const lines = [];

  lines.push("📣【公共报表巡检汇总】");
  lines.push("");
  lines.push(`🕒 巡检时间：${formatCompactZonedDateTime(result.checkedAt, "Asia/Shanghai")}（北京时间）`);
  lines.push("");
  lines.push("📊 异常概览");
  lines.push(`• 检查范围：${result.checkedCardCount || 0}张卡片`);
  lines.push(`• 异常数量：${result.anomalyCount || anomalies.length}条`);
  lines.push(`• 数据缺失：${missingAnomalies.length}条`);
  lines.push(`• 数据波动：${fluctuationAnomalies.length}条`);
  appendCheckedDashboardSummary(lines, result, {
    includeList: anomalies.length === 0 && !hasDataQualityIssue(result.dataQuality),
    maxDashboards: options.maxHealthySummaryDashboards || 12,
  });
  appendDataQualitySummary(lines, result.dataQuality);

  if (anomalies.length === 0 && !hasDataQualityIssue(result.dataQuality)) {
    lines.push("");
    lines.push("✅ 本次巡检未发现异常。");
    appendDetailUrl(lines, detailUrl);
    return lines.join("\n");
  }

  if (anomalies.length === 0) {
    lines.push("");
    lines.push("✅ 报表巡检未发现异常；数据质量异常见上方。");
    appendDetailUrl(lines, detailUrl);
    return lines.join("\n");
  }

  lines.push("");
  lines.push("🌏 国家分布");
  for (const group of countryGroups) {
    const { missingAnomalies: countryMissing, fluctuationAnomalies: countryFluctuation } = classifyPublicAnomalies(
      group.anomalies,
    );
    const dashboardCount = groupAnomaliesByDashboard(group.anomalies).length;
    const cardCount = groupAnomaliesByReportCard(group.anomalies).length;
    lines.push(
      `• ${group.label}：共${group.anomalies.length}条，缺失${countryMissing.length}条，波动${countryFluctuation.length}条，涉及${dashboardCount}个看板/${cardCount}张卡片`,
    );
  }

  appendTopAnomalyDashboardSummary(lines, anomalies, options.maxSummaryAnomalyDashboards || 5);
  appendTopSevereAnomalies(lines, anomalies, options.maxSummaryTopAnomalies || 5);

  lines.push("");
  lines.push("后续每个异常国家各发1条聚合明细；总览只展示 Top 项。");
  appendDetailUrl(lines, detailUrl);

  return lines.join("\n");
}

function buildCountryPublicCheckMessage(result, group, options = {}) {
  const maxGroupsPerCategory = Number(options.maxGroupsPerCountryCategory || options.maxGroupsPerCategory || options.maxAnomalies || 8);
  const { missingAnomalies, fluctuationAnomalies } = classifyPublicAnomalies(group.anomalies);
  const anomalyCardCount = groupAnomaliesByReportCard(group.anomalies).length;
  const qualityMetric = findDataQualityMetric(result.dataQuality, group);
  const detailUrl = appendCountryToDetailUrl(normalizeDetailUrl(options.detailUrl), group.countryCode || group.key || "");
  const lines = [];

  lines.push(`🚨【${group.label} 公共报表巡检异常】`);
  lines.push("");
  lines.push(`🕒 巡检时间：${formatCompactZonedDateTime(result.checkedAt, "Asia/Shanghai")}（北京时间）`);
  lines.push("");
  lines.push("📊 异常概览");
  lines.push(`• 数据缺失：${missingAnomalies.length}条`);
  lines.push(`• 数据波动：${fluctuationAnomalies.length}条`);
  if (qualityMetric) {
    lines.push(`• 数据质量当前异常：${formatDataQualityMetric(qualityMetric)}`);
  }
  lines.push(`• 异常卡片：${anomalyCardCount}个`);

  lines.push("");
  lines.push("━━━━━━━━━━━━━━");
  lines.push("");
  lines.push(`🔴 数据缺失异常（${missingAnomalies.length}条）`);
  appendCompactGroupedAnomalyDetails(lines, missingAnomalies, maxGroupsPerCategory, { emptyText: "暂无异常", mode: "missing" });

  lines.push("");
  lines.push("━━━━━━━━━━━━━━");
  lines.push("");
  lines.push(`🟡 数据波动异常（${fluctuationAnomalies.length}条）`);
  appendCompactGroupedAnomalyDetails(lines, fluctuationAnomalies, maxGroupsPerCategory, { emptyText: "暂无异常", mode: "fluctuation" });

  appendDashboardLinks(lines, group.anomalies);
  appendDetailUrl(lines, detailUrl, "查看本次巡检完整明细");

  return lines.join("\n");
}

function normalizeDetailUrl(value) {
  return String(value || "").trim();
}

function appendCountryToDetailUrl(url, countryCode) {
  if (!url || !countryCode) {
    return url;
  }
  try {
    const parsed = new URL(url);
    const [hashPath, hashQuery = ""] = String(parsed.hash || "").replace(/^#/, "").split("?");
    const params = new URLSearchParams(hashQuery);
    params.set("countryCode", countryCode);
    parsed.hash = `${hashPath || "/batch-check"}?${params.toString()}`;
    return parsed.toString();
  } catch {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}countryCode=${encodeURIComponent(countryCode)}`;
  }
}

function appendDetailUrl(lines, detailUrl, label = "查看完整明细") {
  if (!detailUrl) {
    return;
  }
  lines.push("");
  lines.push(`🔎 ${label}：${detailUrl}`);
}

function appendCheckedDashboardSummary(lines, result, options = {}) {
  const dashboardGroups = groupCheckedCardsByDashboard(result.checkedCards || []);
  const dashboardCount = Number(result.dashboardCount || dashboardGroups.length || 0);

  if (dashboardCount > 0) {
    lines.push(`• 覆盖看板：${dashboardCount}个`);
  }

  if (dashboardGroups.length === 0) {
    return;
  }

  if (options.includeList === false) {
    return;
  }

  const maxDashboards = Number(options.maxDashboards || 12);
  lines.push("");
  lines.push("🧭 巡检看板");

  for (const group of dashboardGroups.slice(0, maxDashboards)) {
    const countryLabel = formatCountryLabel(group);
    const location = [countryLabel, group.dashboardTitle || "未知看板"].filter(Boolean).join(" / ");
    lines.push(`• ${location}：${group.cardCount}张卡片`);
  }

  if (dashboardGroups.length > maxDashboards) {
    const hiddenCardCount = dashboardGroups
      .slice(maxDashboards)
      .reduce((sum, group) => sum + group.cardCount, 0);
    lines.push(`• 另有${dashboardGroups.length - maxDashboards}个看板、${hiddenCardCount}张卡片未展示`);
  }
}

function appendTopAnomalyDashboardSummary(lines, anomalies, limit) {
  const groups = groupAnomaliesByDashboard(anomalies)
    .sort((left, right) => {
      return right.items.length - left.items.length || maxGroupSeverity({ items: right.items }) - maxGroupSeverity({ items: left.items });
    });

  if (groups.length === 0) {
    return;
  }

  lines.push("");
  lines.push(`🧭 异常看板 Top ${Math.min(limit, groups.length)}`);
  for (const group of groups.slice(0, limit)) {
    const { missingAnomalies: missing, fluctuationAnomalies: fluctuation } = classifyPublicAnomalies(group.items);
    const cardCount = groupAnomaliesByReportCard(group.items).length;
    const top = summarizeTopAnomaly(group.items);
    lines.push(
      `• ${formatCountryLabel(group)} / ${group.dashboardTitle || "未知看板"}：${group.items.length}条，${cardCount}张卡片，缺失${missing.length}、波动${fluctuation.length}${top ? `，最大${top}` : ""}`,
    );
  }

  if (groups.length > limit) {
    const hiddenCount = groups.slice(limit).reduce((sum, group) => sum + group.items.length, 0);
    lines.push(`• 另有${groups.length - limit}个异常看板、${hiddenCount}条异常未在总览展开`);
  }
}

function appendTopSevereAnomalies(lines, anomalies, limit) {
  const items = [...(anomalies || [])]
    .sort((left, right) => extractAnomalySeverity(right.message) - extractAnomalySeverity(left.message))
    .slice(0, limit);

  if (items.length === 0) {
    return;
  }

  lines.push("");
  lines.push(`🔎 最严重异常 Top ${items.length}`);
  for (const anomaly of items) {
    lines.push(`• ${formatCompactAnomalySummary(anomaly)}`);
  }
}

function groupAnomaliesByDashboard(anomalies) {
  const groups = new Map();

  for (const anomaly of anomalies || []) {
    const key = [
      anomaly.countryCode || anomaly.countryName || "",
      anomaly.dashboardTitle || "",
    ].join("\u0000");

    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: anomaly.countryCode,
        countryName: anomaly.countryName,
        dashboardTitle: anomaly.dashboardTitle,
        items: [],
      });
    }

    groups.get(key).items.push(anomaly);
  }

  return [...groups.values()];
}

function summarizeTopAnomaly(anomalies) {
  const top = [...(anomalies || [])]
    .sort((left, right) => extractAnomalySeverity(right.message) - extractAnomalySeverity(left.message))[0];
  if (!top?.message) {
    return "";
  }

  const summary = summarizeFluctuationMessage(top.message);
  if (summary.change) {
    return summary.change;
  }

  return top.message.slice(0, 36);
}

function formatCompactAnomalySummary(anomaly) {
  const location = [
    formatCountryLabel(anomaly),
    anomaly.dashboardTitle,
    anomaly.cardTitle || anomaly.cardName,
  ].filter(Boolean).join(" / ");
  const summary = summarizeFluctuationMessage(anomaly.message || "");
  const details = [];

  if (summary.change) {
    details.push(summary.change);
  }
  if (summary.from !== "" && summary.to !== "") {
    details.push(`${summary.from} → ${summary.to}`);
  }
  if (summary.context) {
    details.push(summary.context);
  }

  return `${location || "未知卡片"}：${details.join("，") || String(anomaly.message || "").slice(0, 80)}`;
}

function groupCheckedCardsByDashboard(checkedCards) {
  const groups = new Map();

  for (const card of checkedCards || []) {
    const key = [
      card.countryCode || card.countryName || "",
      card.dashboardTitle || "",
    ].join("\u0000");

    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: card.countryCode,
        countryName: card.countryName,
        dashboardTitle: card.dashboardTitle || "未知看板",
        cardCount: 0,
      });
    }

    groups.get(key).cardCount += 1;
  }

  return [...groups.values()].sort((left, right) => {
    const leftLabel = [formatCountryLabel(left), left.dashboardTitle].filter(Boolean).join("/");
    const rightLabel = [formatCountryLabel(right), right.dashboardTitle].filter(Boolean).join("/");
    return leftLabel.localeCompare(rightLabel, "zh-CN");
  });
}

function appendDataQualitySummary(lines, dataQuality) {
  const metrics = dataQuality?.countries || [];
  if (metrics.length === 0) {
    return;
  }

  lines.push("");
  lines.push("🧪 数据质量当前异常");
  for (const metric of metrics) {
    lines.push(`• ${formatCountryLabel(metric)}：${formatDataQualityMetric(metric)}`);
  }
}

function findDataQualityMetric(dataQuality, group) {
  const metrics = dataQuality?.countries || [];
  const groupLabel = group.label || "";
  return metrics.find((metric) => {
    return metric.countryCode === group.countryCode
      || (metric.countryName && metric.countryName === group.countryName)
      || (metric.countryCode && metric.countryCode === group.key)
      || (metric.countryName && metric.countryName === group.key)
      || (metric.countryCode && groupLabel.includes(`(${metric.countryCode})`))
      || (metric.countryName && groupLabel.includes(metric.countryName));
  });
}

function formatDataQualityMetric(metric) {
  if (!metric) {
    return "未检查";
  }

  if (metric.status === "ok") {
    return `${formatCompactNumber(metric.currentAnomalyCount || 0)}条`;
  }

  return `获取失败（${formatDataQualityError(metric.error, metric.status)}）`;
}

function formatDataQualityError(error, status) {
  const text = String(error || status || "unknown");
  if (/401|unauthorized/i.test(text)) {
    return "401 Unauthorized";
  }

  if (/timeout|timed out/i.test(text)) {
    return "请求超时";
  }

  return text.replace(/\s+/g, " ").slice(0, 80);
}

function formatCompactNumber(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return String(value);
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(numberValue) ? 0 : 2,
  }).format(numberValue);
}

function groupAnomaliesByCountry(anomalies) {
  const groups = new Map();

  for (const anomaly of anomalies || []) {
    const key = anomaly.countryCode || anomaly.countryName || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: formatCountryLabel(anomaly) || "未标国家",
        countryCode: anomaly.countryCode,
        countryName: anomaly.countryName,
        anomalies: [],
      });
    }
    groups.get(key).anomalies.push(anomaly);
  }

  return [...groups.values()];
}

function getPublicAlertCount(result) {
  const reportAnomalyCount = result.anomalyCount ?? (result.anomalies || []).length;
  return reportAnomalyCount + countDataQualityIssues(result.dataQuality);
}

function hasDataQualityIssue(dataQuality) {
  return countDataQualityIssues(dataQuality) > 0;
}

function countDataQualityIssues(dataQuality) {
  return (dataQuality?.countries || []).reduce((sum, metric) => {
    if (metric.status === "ok") {
      const currentAnomalyCount = Number(metric.currentAnomalyCount || 0);
      return sum + (Number.isFinite(currentAnomalyCount) && currentAnomalyCount > 0 ? currentAnomalyCount : 0);
    }

    return sum + 1;
  }, 0);
}

function classifyPublicAnomalies(anomalies) {
  const missingTypes = new Set([
    "requiredDatePresent",
    "staleLatestDate",
    "noData",
    "queryError",
    "intradayTimePointCompleteness",
  ]);
  const missingAnomalies = [];
  const fluctuationAnomalies = [];

  for (const anomaly of anomalies || []) {
    if (missingTypes.has(anomaly.type)) {
      missingAnomalies.push(anomaly);
    } else {
      fluctuationAnomalies.push(anomaly);
    }
  }

  return { missingAnomalies, fluctuationAnomalies };
}

function appendAnomalyDetails(lines, anomalies, limit, options = {}) {
  if (anomalies.length === 0) {
    lines.push("- 0条");
    return;
  }

  for (const [index, anomaly] of anomalies.slice(0, limit).entries()) {
    lines.push(`${index + 1}. ${formatAnomalyLine(anomaly, options)}`);
    if (options.includeDashboardUrl !== false && anomaly.dashboardUrl) {
      lines.push(`   ${anomaly.dashboardUrl}`);
    }
  }

  if (anomalies.length > limit) {
    lines.push(`还有 ${anomalies.length - limit} 条异常未展示。`);
  }
}

function appendGroupedAnomalyDetails(lines, anomalies, limit, options = {}) {
  if (anomalies.length === 0) {
    lines.push("- 0条");
    return;
  }

  const maxExamplesPerGroup = Number(options.maxExamplesPerGroup || 3);
  const groups = groupAnomaliesByReportCard(anomalies).sort((left, right) => {
    return right.items.length - left.items.length || maxGroupSeverity(right) - maxGroupSeverity(left);
  });

  for (const [index, group] of groups.slice(0, limit).entries()) {
    lines.push(`${index + 1}. ${formatGroupLocation(group, options)}：${group.items.length} 条异常`);

    const examples = [...group.items]
      .sort((left, right) => extractAnomalySeverity(right.message) - extractAnomalySeverity(left.message))
      .slice(0, maxExamplesPerGroup);

    for (const [exampleIndex, anomaly] of examples.entries()) {
      lines.push(`   - Top${exampleIndex + 1}：${anomaly.message}`);
    }

    if (group.items.length > examples.length) {
      lines.push(`   - 另有 ${group.items.length - examples.length} 条同卡片异常未展开`);
    }

    const dashboardUrl = firstDashboardUrl(group.items);
    if (dashboardUrl) {
      lines.push(`   - 报表：${dashboardUrl}`);
    }
  }

  if (groups.length > limit) {
    const hiddenCount = groups.slice(limit).reduce((sum, group) => sum + group.items.length, 0);
    lines.push(`还有 ${groups.length - limit} 个卡片组、${hiddenCount} 条异常未展示。`);
  }
}

function appendCompactGroupedAnomalyDetails(lines, anomalies, limit, options = {}) {
  if (anomalies.length === 0) {
    lines.push(options.emptyText || "暂无异常");
    return;
  }

  const dashboardGroups = groupReportCardGroupsByDashboard(anomalies);
  let shownCount = 0;

  for (const dashboardGroup of dashboardGroups) {
    if (shownCount >= limit) {
      break;
    }

    const comparisonContext = options.mode === "fluctuation"
      ? extractCommonComparisonContext(dashboardGroup.groups.flatMap((group) => group.items))
      : null;
    lines.push("");
    lines.push(formatCompactDashboardTitle(dashboardGroup, comparisonContext));

    for (const reportCardGroup of dashboardGroup.groups) {
      if (shownCount >= limit) {
        break;
      }

      const ordinal = formatCircledNumber(shownCount + 1);
      lines.push("");
      lines.push(`${ordinal} ${formatCompactCardTitle(reportCardGroup)}（${reportCardGroup.items.length}条）`);

      if (options.mode === "missing") {
        appendCompactMissingSummary(lines, reportCardGroup);
      } else {
        appendCompactFluctuationSummary(lines, reportCardGroup, { comparisonContext });
      }

      shownCount += 1;
    }
  }

  const allGroups = groupAnomaliesByReportCard(anomalies);
  if (allGroups.length > limit) {
    const hiddenCount = allGroups.slice(limit).reduce((sum, item) => sum + item.items.length, 0);
    lines.push("");
    lines.push(`另有 ${allGroups.length - limit} 个卡片组、${hiddenCount} 条异常未展示`);
  }
}

function appendCompactMissingSummary(lines, group) {
  const topAnomaly = [...group.items].sort((left, right) => {
    return extractAnomalySeverity(right.message) - extractAnomalySeverity(left.message);
  })[0];

  if (topAnomaly?.message) {
    lines.push(`   摘要：${topAnomaly.message}`);
  }

  if (group.items.length > 1) {
    lines.push(`   另有 ${group.items.length - 1} 条同卡片异常`);
  }
}

function appendCompactFluctuationSummary(lines, group, options = {}) {
  const summaries = group.items
    .map((item) => summarizeFluctuationMessage(item.message || ""))
    .filter((summary) => summary.change || summary.detail);
  const positiveSummaries = summaries.filter((summary) => Number.isFinite(summary.numericChange) && summary.numericChange > 0);
  const negativeSummaries = summaries.filter((summary) => Number.isFinite(summary.numericChange) && summary.numericChange < 0);

  if (positiveSummaries.length > 0 && negativeSummaries.length > 0) {
    appendFluctuationSummaryLines(lines, "最大上涨", maxSummaryByAbsChange(positiveSummaries), options);
    appendFluctuationSummaryLines(lines, "最大下跌", maxSummaryByAbsChange(negativeSummaries), options);
    return;
  }

  const topAnomaly = [...group.items].sort((left, right) => {
    return extractAnomalySeverity(right.message) - extractAnomalySeverity(left.message);
  })[0];
  const summary = summarizeFluctuationMessage(topAnomaly?.message || "");

  appendFluctuationSummaryLines(lines, "最大波动", summary, options);
}

function appendFluctuationSummaryLines(lines, label, summary, options = {}) {
  lines.push(`   ${label}：${summary.change || "未知"}`);
  if (summary.baseline) {
    lines.push(
      `   近${summary.baseline.lookbackDays}天基线：${summary.baseline.value}（样本${summary.baseline.sampleCount}天），较基线 ${summary.baseline.change}`,
    );
  }
  if (summary.trigger) {
    lines.push(`   判定依据：${summary.trigger}`);
  }
  const displayContext = stripCommonComparisonFromContext(summary.context, options.comparisonContext);
  if (displayContext) {
    lines.push(`   时间点：${displayContext}`);
  }
  if (summary.from !== "" && summary.to !== "") {
    lines.push(`   ${summary.from} → ${summary.to}`);
  } else if (summary.detail) {
    lines.push(`   ${summary.detail}`);
  }
}

function maxSummaryByAbsChange(summaries) {
  return [...summaries].sort((left, right) => Math.abs(right.numericChange) - Math.abs(left.numericChange))[0] || {};
}

function formatCompactDashboardTitle(dashboardGroup, comparisonContext = null) {
  const title = dashboardGroup.dashboardTitle || "未知看板";
  return comparisonContext?.text ? `【${title}（${comparisonContext.text}）】` : `【${title}】`;
}

function groupReportCardGroupsByDashboard(anomalies) {
  const reportCardGroups = groupAnomaliesByReportCard(anomalies).sort((left, right) => {
    return maxGroupSeverity(right) - maxGroupSeverity(left) || right.items.length - left.items.length;
  });
  const dashboards = new Map();

  for (const reportCardGroup of reportCardGroups) {
    const key = reportCardGroup.dashboardTitle || "未知看板";
    if (!dashboards.has(key)) {
      dashboards.set(key, {
        dashboardTitle: key,
        groups: [],
      });
    }
    dashboards.get(key).groups.push(reportCardGroup);
  }

  return [...dashboards.values()];
}

function groupAnomaliesByReportCard(anomalies) {
  const groups = new Map();

  for (const anomaly of anomalies || []) {
    const key = [
      anomaly.countryCode || anomaly.countryName || "",
      anomaly.dashboardTitle || "",
      anomaly.context || "",
      anomaly.cardTitle || anomaly.cardName || "",
    ].join("\u0000");

    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: anomaly.countryCode,
        countryName: anomaly.countryName,
        dashboardTitle: anomaly.dashboardTitle,
        context: anomaly.context,
        cardTitle: anomaly.cardTitle || anomaly.cardName,
        items: [],
      });
    }

    groups.get(key).items.push(anomaly);
  }

  return [...groups.values()];
}

function formatGroupLocation(group, options = {}) {
  return [
    options.includeCountry === false ? "" : formatCountryLabel(group),
    group.dashboardTitle,
    group.context,
    group.cardTitle,
  ]
    .filter(Boolean)
    .join(" / ");
}

function formatCompactCardTitle(group) {
  return [group.context, group.cardTitle || "未知卡片"].filter(Boolean).join(" / ");
}

function maxGroupSeverity(group) {
  return Math.max(...group.items.map((item) => extractAnomalySeverity(item.message)), 0);
}

function extractAnomalySeverity(message = "") {
  const percentagePointMatches = [...String(message).matchAll(/([+-]?\d+(?:\.\d+)?)\s*个百分/g)];
  const percentageMatches = [...String(message).matchAll(/([+-]?\d+(?:\.\d+)?)%/g)];
  const values = [...percentagePointMatches, ...percentageMatches]
    .map((match) => Math.abs(Number(match[1])))
    .filter(Number.isFinite);

  return values.length > 0 ? Math.max(...values) : 0;
}

function summarizeFluctuationMessage(message = "") {
  const text = String(message);
  const fromToMatch = text.match(/从\s*([0-9,.]+%?)\s*到\s*([0-9,.]+%?)/);
  const changeMatch = text.match(/波动\s*([+-]?\d+(?:\.\d+)?%)/)
    || text.match(/绝对变化\s*([+-]?\d+(?:\.\d+)?)\s*个百分/);
  const numericChange = parseChangeNumber(changeMatch);
  const context = extractMessageContext(text);
  const baseline = extractBaselineSummary(text);
  const trigger = extractTriggerSummary(text);

  if (fromToMatch) {
    return {
      change: changeMatch ? formatChangeText(changeMatch[0], changeMatch[1]) : "",
      from: formatMetricValue(fromToMatch[1]),
      to: formatMetricValue(fromToMatch[2]),
      detail: "",
      numericChange,
      context,
      baseline,
      trigger,
    };
  }

  const progressMatch = text.match(/进度\s*([0-9,.]+%)\s*(低于|高于)期望\s*([0-9,.]+%)/);
  const dateValueMatches = [...text.matchAll(/\d{4}-\d{2}-\d{2}=([0-9,.]+)/g)].map((match) => match[1]);
  if (progressMatch) {
    return {
      change: `进度${progressMatch[2]}期望`,
      from: "",
      to: "",
      detail: dateValueMatches.length >= 2
        ? `${formatMetricValue(dateValueMatches[0])} / ${formatMetricValue(dateValueMatches[1])}（进度${progressMatch[1]}，期望${progressMatch[3]}）`
        : `进度${progressMatch[1]}，期望${progressMatch[3]}`,
      numericChange: Number.NaN,
      context,
      baseline,
      trigger,
    };
  }

  return {
    change: changeMatch ? formatChangeText(changeMatch[0], changeMatch[1]) : "",
    from: "",
    to: "",
    detail: text,
    numericChange,
    context,
    baseline,
    trigger,
  };
}

function extractBaselineSummary(text = "") {
  const match = String(text).match(
    /近(\d+)天同点中位数\s*([0-9,.]+%?)（样本(\d+)天），较基线\s*([+-]?\d+(?:\.\d+)?%)/,
  );
  if (!match) {
    return null;
  }

  return {
    lookbackDays: Number(match[1]),
    value: formatMetricValue(match[2]),
    sampleCount: Number(match[3]),
    change: match[4],
  };
}

function extractTriggerSummary(text = "") {
  const match = String(text).match(/；判定：(.+?)(?:（|$)/);
  return match ? match[1].trim() : "";
}

function parseChangeNumber(changeMatch) {
  if (!changeMatch) {
    return Number.NaN;
  }

  const value = Number(String(changeMatch[1] || "").replace("%", ""));
  return Number.isFinite(value) ? value : Number.NaN;
}

function extractMessageContext(text) {
  const match = String(text).match(/（([^）]+)）/);
  return match ? match[1] : "";
}

function extractCommonComparisonContext(items) {
  const infos = (items || [])
    .map((item) => extractComparisonContext(extractMessageContext(item.message || "")))
    .filter(Boolean);

  if (infos.length === 0) {
    return null;
  }

  const datePairs = new Set(infos.map((info) => info.datePair));
  if (datePairs.size !== 1) {
    return null;
  }

  const textCounts = new Map();
  for (const info of infos) {
    textCounts.set(info.text, (textCounts.get(info.text) || 0) + 1);
  }

  const [text] = [...textCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  return {
    text,
    datePair: infos[0].datePair,
  };
}

function extractComparisonContext(context = "") {
  const segment = String(context)
    .split("，")
    .map((part) => part.trim())
    .find((part) => /\d{4}-\d{2}-\d{2}\s*对比\s*\d{4}-\d{2}-\d{2}/.test(part));

  if (!segment) {
    return null;
  }

  const datePairMatch = segment.match(/(\d{4}-\d{2}-\d{2})\s*对比\s*(\d{4}-\d{2}-\d{2})/);
  if (!datePairMatch) {
    return null;
  }

  return {
    text: segment,
    datePair: `${datePairMatch[1]} 对比 ${datePairMatch[2]}`,
  };
}

function stripCommonComparisonFromContext(context = "", comparisonContext = null) {
  if (!context || !comparisonContext?.datePair) {
    return context;
  }

  return String(context)
    .split("，")
    .filter((part) => {
      const info = extractComparisonContext(part);
      return info?.datePair !== comparisonContext.datePair;
    })
    .join("，")
    .trim();
}

function formatChangeText(fullMatch, value) {
  if (String(fullMatch).includes("个百分")) {
    return `${value}个百分点`;
  }
  return value;
}

function formatMetricValue(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  const hasPercent = text.endsWith("%");
  const numericText = hasPercent ? text.slice(0, -1) : text;
  const normalized = numericText.replaceAll(",", "");
  const numberValue = Number(normalized);

  if (!Number.isFinite(numberValue)) {
    return text;
  }

  const hasDecimal = normalized.includes(".");
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: hasDecimal ? Math.min(normalized.split(".")[1]?.length || 0, 4) : 0,
    maximumFractionDigits: hasDecimal ? 4 : 0,
  }).format(numberValue);

  return hasPercent ? `${formatted}%` : formatted;
}

function formatCircledNumber(value) {
  const circledNumbers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
  return circledNumbers[value - 1] || `${value}.`;
}

function appendDashboardLinks(lines, anomalies) {
  const links = [];
  const seen = new Set();

  for (const anomaly of anomalies || []) {
    if (!anomaly.dashboardUrl || seen.has(anomaly.dashboardUrl)) {
      continue;
    }
    seen.add(anomaly.dashboardUrl);
    links.push({
      title: anomaly.dashboardTitle || "未知看板",
      url: anomaly.dashboardUrl,
    });
  }

  if (links.length === 0) {
    return;
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━");
  lines.push("");

  if (links.length === 1) {
    lines.push(`🔗 看板：${links[0].title}`);
    lines.push(links[0].url);
    return;
  }

  lines.push("🔗 看板链接");
  for (const link of links) {
    lines.push(`• ${link.title}`);
    lines.push(link.url);
  }
}

function firstDashboardUrl(anomalies) {
  return anomalies.find((anomaly) => anomaly.dashboardUrl)?.dashboardUrl || "";
}

function formatAnomalyLine(anomaly, options = {}) {
  const location = [
    options.includeCountry === false ? "" : formatCountryLabel(anomaly),
    anomaly.dashboardTitle,
    anomaly.context,
    anomaly.cardTitle,
  ]
    .filter(Boolean)
    .join(" / ");
  return `${location}：${anomaly.message}`;
}

function formatCountryLabel(anomaly) {
  if (anomaly.countryName && anomaly.countryCode) {
    return `${anomaly.countryName}(${anomaly.countryCode})`;
  }

  return anomaly.countryName || anomaly.countryCode || "";
}

export function buildWebhookPayload(channel, message, metadata = {}, alertConfig = {}) {
  switch (normalizeAlertChannel(channel)) {
    case "feishu":
      return {
        msg_type: "text",
        content: { text: message },
      };
    case "wecom":
      return {
        msgtype: "markdown",
        markdown: { content: message.replace(/\n/g, "\n") },
      };
    case "slack":
      return {
        text: message,
      };
    case "tv": {
      const mentions = normalizeMentions(alertConfig.mentions);
      return {
        botId: resolveEnvString(alertConfig.botId),
        message,
        ...(mentions.length ? { mentions } : {}),
      };
    }
    case "generic":
      return {
        [alertConfig.textField || "text"]: message,
      };
    default:
      throw new Error(`Unsupported alert channel: ${channel}`);
  }
}

function normalizeAlertChannel(channel) {
  const value = String(channel || "").trim();
  if (["knBot", "knChatBot", "kn_chat_bot", "kn-chat-bot"].includes(value)) {
    return "knBot";
  }
  return value;
}

function normalizeChatIds(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEmailRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendMentionText(message, value) {
  const mentions = normalizeMentions(value);
  if (mentions.length === 0) {
    return message;
  }
  return `${message}\n\n提醒人：${mentions.join(" ")}`;
}

function normalizeMentions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveEnvString(value) {
  if (!value) {
    return "";
  }

  return String(value).replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] || "");
}

function formatZonedDateTime(value, timezone) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) {
    return String(value || "");
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatCompactZonedDateTime(value, timezone) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) {
    return String(value || "");
  }

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

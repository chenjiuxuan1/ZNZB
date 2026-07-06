export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function json(value) {
  return JSON.stringify(value, null, 2);
}

export function countryLabel(countryOrCode, countries = []) {
  const code = typeof countryOrCode === "string" ? countryOrCode : countryOrCode?.code || countryOrCode?.countryCode;
  const country = countries.find((item) => item.code === code) || countryOrCode;
  return [country?.name, code].filter(Boolean).join(" / ") || "-";
}

export function ruleTypeLabel(type) {
  const labels = {
    requiredDatePresent: "指定日期必须存在",
    completeDayChange: "完整日环比波动",
    intradayProgress: "当日进度检查",
    intradayTimePointCompleteness: "准实时点位完整性",
    intradayTimePointChange: "准实时点位波动",
    latestValueRange: "最新值范围",
    latestZeroRate: "最新零值/零率",
    notEmpty: "数据不能为空",
    rowCountAtLeast: "最少行数",
  };
  return labels[type] || type || "未知规则";
}

export function describeRule(rule = {}) {
  const labels = {
    requiredDatePresent: "检查目标卡片是否包含应更新日期，常用于 D0/D-1 数据新鲜度。",
    completeDayChange: "对完整自然日做前后两天对比，发现异常上升或下降。",
    intradayProgress: "按当前时间判断当日累计进度是否明显低于或高于预期。",
    intradayTimePointCompleteness: "检查准实时表是否缺少应出现的半小时/小时点位。",
    intradayTimePointChange: "对同一时间点和上一日对比，发现准实时指标剧烈波动。",
    latestValueRange: "检查最新一行数值是否超出配置上下限。",
    latestZeroRate: "检查最新日期是否出现异常的 0 值或 0 率。",
    notEmpty: "检查卡片查询结果不能是空数据。",
    rowCountAtLeast: "检查返回行数不能低于配置下限。",
  };
  return labels[rule.type] || "按配置中的字段匹配看板、卡片和列，再交给规则引擎判断是否命中异常。";
}

export function ruleScope(rule = {}, countries = []) {
  if (rule.countryCode) {
    return `仅 ${countryLabel(rule.countryCode, countries)}`;
  }
  if (rule.countryCodes?.length) {
    return rule.countryCodes.map((code) => countryLabel(code, countries)).join("、");
  }
  if (rule.exclude?.length) {
    const excluded = rule.exclude
      .map((item) => item.countryCode)
      .filter(Boolean)
      .map((code) => countryLabel(code, countries))
      .join("、");
    return excluded ? `全部国家，排除 ${excluded}` : "全部国家，带局部排除条件";
  }
  return "全部国家";
}

export function ruleDashboard(rule = {}) {
  return rule.dashboardTitle || rule.dashboardTitles?.join("、") || rule.dashboardTitlePattern || "未限定";
}

export function ruleCards(rule = {}) {
  return rule.cardTitle || rule.cardTitles?.join("、") || rule.cardTitlePattern || "未限定";
}

export function ruleColumns(rule = {}) {
  return rule.columns?.join("、") || rule.columnPattern || rule.dateColumn || rule.timeColumn || "按规则类型自动识别";
}

export function compactList(items = [], limit = 4) {
  const values = items.filter(Boolean);
  if (values.length <= limit) {
    return values.join("、") || "-";
  }
  return `${values.slice(0, limit).join("、")} 等 ${values.length} 项`;
}

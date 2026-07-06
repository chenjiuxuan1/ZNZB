const SAFE_CONFIG_TARGETS = {
  countries: "config/countries.config.json",
  rules: "config/public-monitor.config.json",
};

const RULE_MATCH_FIELDS = [
  "countryCode",
  "countryName",
  "dashboardTitle",
  "dashboardTitles",
  "dashboardTitlePattern",
  "cardTitle",
  "cardTitles",
  "cardTitlePattern",
];

export function assertSafeConfigPath(target) {
  const filePath = SAFE_CONFIG_TARGETS[target];
  if (!filePath) {
    throw new Error(`Unsupported config target: ${target}`);
  }
  return filePath;
}

export function validateCountriesConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || !Array.isArray(config.countries)) {
    return { ok: false, errors: ["countries must be an array"] };
  }

  config.countries.forEach((country, index) => {
    if (!country || typeof country !== "object") {
      errors.push(`countries[${index}] must be an object`);
      return;
    }
    requireString(errors, country.code, `countries[${index}].code`);
    requireString(errors, country.name, `countries[${index}].name`);
    requireString(errors, country.timezone, `countries[${index}].timezone`);
    optionalUrl(errors, country.grafanaDashboardUrl, `countries[${index}].grafanaDashboardUrl`);
    optionalUrl(errors, country.dataQualityDashboardUrl, `countries[${index}].dataQualityDashboardUrl`);
    if (country.monitorConfigFile !== undefined && typeof country.monitorConfigFile !== "string") {
      errors.push(`countries[${index}].monitorConfigFile must be a string`);
    }
    if (country.status !== undefined && typeof country.status !== "string") {
      errors.push(`countries[${index}].status must be a string`);
    }
  });

  return { ok: errors.length === 0, errors };
}

export function validateRulesConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return { ok: false, errors: ["rules config must be an object"] };
  }
  if (!Array.isArray(config.rules)) {
    return { ok: false, errors: ["rules must be an array"] };
  }

  config.rules.forEach((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`rules[${index}] must be an object`);
      return;
    }
    requireString(errors, rule.type, `rules[${index}].type`);
    const hasMatcher = RULE_MATCH_FIELDS.some((field) => rule[field] !== undefined);
    if (!hasMatcher) {
      errors.push(`rules[${index}] must include a dashboard/card/country matcher`);
    }
    for (const field of ["parameters", "exclude", "correlatedChangeSuppressions"]) {
      if (rule[field] !== undefined && !Array.isArray(rule[field])) {
        errors.push(`rules[${index}].${field} must be an array`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

export function validateSandboxRequest(body) {
  const errors = [];
  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["request body must be an object"] };
  }
  if (!body.rule || typeof body.rule !== "object" || Array.isArray(body.rule)) {
    errors.push("rule must be an object");
  }
  if (!Array.isArray(body.rows)) {
    errors.push("rows must be an array");
  }
  if (body.dashboard !== undefined && (!body.dashboard || typeof body.dashboard !== "object")) {
    errors.push("dashboard must be an object when provided");
  }
  if (body.card !== undefined && (!body.card || typeof body.card !== "object")) {
    errors.push("card must be an object when provided");
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeRuleMessages(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  return [String(value)];
}

function requireString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}

function optionalUrl(errors, value, path) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${path} must be a URL string`);
    return;
  }
  try {
    new URL(value);
  } catch {
    errors.push(`${path} must be a valid URL`);
  }
}

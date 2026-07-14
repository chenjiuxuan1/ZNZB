import { uniqueStrings } from "./utils.mjs";

export function flattenPanels(dashboard) {
  const result = [];
  visitPanels(dashboard?.panels || [], result);
  return result;
}

export function getDashboardTimeRange(dashboard) {
  return dashboard?.time || null;
}

export function describePanels(panels) {
  return panels.map((panel) => ({
    id: panel.id,
    title: panel.title || `Panel ${panel.id}`,
    type: panel.type,
    datasource: panel.datasource?.uid || panel.datasource?.type || panel.datasource || "unknown",
    targetCount: (panel.targets || []).filter((target) => !target.hide).length,
    links: extractPanelLinks(panel),
    textPreview: buildTextPreview(panel),
  }));
}

export function buildPanelQueries(panel, variables) {
  const defaultDatasource = panel.datasource;
  const targets = (panel.targets || []).filter((target) => !target.hide);

  return targets
    .map((target, index) => {
      const query = substituteVariables(deepClone(target), variables);
      query.datasource = normalizeDatasource(query.datasource || defaultDatasource);
      query.refId = query.refId || String.fromCharCode(65 + index);
      query.intervalMs = query.intervalMs || 60_000;
      query.maxDataPoints = query.maxDataPoints || 1000;
      return query;
    })
    .filter((query) => query.datasource);
}

export function panelKey(panel) {
  return `${panel.id}:${panel.title || `Panel ${panel.id}`}`;
}

export function buildDashboardLink(config, panel) {
  const dashboardUrl = config.grafana.dashboardUrl
    || `${config.grafana.baseUrl}/d/${config.grafana.dashboardUid}`;
  const separator = dashboardUrl.includes("?") ? "&" : "?";
  return `${dashboardUrl}${separator}viewPanel=${panel.id}`;
}

export function findPanel(panels, rule) {
  return panels.find((panel) => {
    if (rule.panelId !== undefined && panel.id === rule.panelId) {
      return true;
    }

    if (rule.panelTitle && (panel.title || "").trim() === rule.panelTitle.trim()) {
      return true;
    }

    return false;
  });
}

function visitPanels(panels, result) {
  for (const panel of panels) {
    if (Array.isArray(panel.panels)) {
      visitPanels(panel.panels, result);
    }

    if (Array.isArray(panel.collapsed)) {
      visitPanels(panel.collapsed, result);
    }

    if (panel.type !== "row") {
      result.push(panel);
    }
  }
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeDatasource(datasource) {
  if (!datasource) {
    return null;
  }

  if (typeof datasource === "string") {
    return { uid: datasource };
  }

  if (typeof datasource === "object") {
    return datasource;
  }

  return null;
}

function substituteVariables(value, variables) {
  if (typeof value === "string") {
    return substituteString(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteVariables(item, variables));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteVariables(entry, variables)]),
    );
  }

  return value;
}

function substituteString(template, variables) {
  let output = template;
  for (const [key, value] of Object.entries(variables || {})) {
    const normalized = Array.isArray(value) ? value.join(",") : String(value);
    output = output
      .replaceAll(`\${${key}}`, normalized)
      .replaceAll(`$${key}`, normalized)
      .replaceAll(`[[${key}]]`, normalized);
  }
  return output;
}

export function panelTextList(snapshot) {
  return uniqueStrings(snapshot.textValues || []);
}

function buildTextPreview(panel) {
  const text = getTextPanelContent(panel)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return null;
  }

  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function extractPanelLinks(panel) {
  const links = [];

  for (const link of panel.links || []) {
    if (link.url) {
      links.push({
        title: link.title || link.url,
        url: link.url,
      });
    }
  }

  const content = getTextPanelContent(panel);
  const markdownLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const hrefPattern = /href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  const plainUrlPattern = /https?:\/\/[^\s"'<>)]*/g;

  for (const match of content.matchAll(markdownLinkPattern)) {
    links.push({ title: match[1].trim() || match[2], url: match[2].trim() });
  }

  for (const match of content.matchAll(hrefPattern)) {
    const title = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    links.push({ title: title || match[1], url: match[1].trim() });
  }

  for (const match of content.matchAll(plainUrlPattern)) {
    links.push({ title: match[0], url: match[0] });
  }

  return dedupeLinks(links);
}

function getTextPanelContent(panel) {
  if (typeof panel.options?.content === "string") {
    return panel.options.content;
  }

  if (typeof panel.content === "string") {
    return panel.content;
  }

  return "";
}

function dedupeLinks(links) {
  const seen = new Set();
  const result = [];

  for (const link of links) {
    if (!link.url || seen.has(link.url)) {
      continue;
    }
    seen.add(link.url);
    result.push(link);
  }

  return result;
}

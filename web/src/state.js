export const state = {
  route: parseHashRoute().path,
  routeQuery: parseHashRoute().query,
  summary: null,
  countries: null,
  inventory: null,
  rulesConfig: null,
  sandboxResult: null,
  sandboxRows: null,
  sandboxStatus: null,
  sandboxError: "",
  sandboxSort: {
    column: "",
    direction: "asc",
  },
  batchCheckResult: null,
  batchCheckStatus: null,
  batchCheckError: "",
  batchSchedule: null,
  batchScheduleStatus: null,
  batchScheduleError: "",
  batchScheduleProgress: null,
  batchScheduleProgressTimer: null,
  batchHistory: null,
  batchHistoryFilters: {
    countryCode: "",
    status: "",
  },
  batchHistoryStatus: null,
  batchCheckTab: "manual",
  wattrelCurrentResult: null,
  wattrelCurrentStatus: null,
  wattrelCurrentLoaded: false,
  wattrelSelectedCountryCode: "",
  wattrelFilters: {
    countryCode: "",
    limit: 100,
  },
  wattrelQueryResult: null,
  wattrelQueryStatus: null,
  wattrelQueryError: "",
  qualityRuleGenerationResult: null,
  qualityRuleGenerationStatus: null,
  qualityRuleGenerationLoaded: false,
  qualityRuleGenerationCountry: "",
  qualityRuleGenerationEditor: {
    open: false,
    row: null,
    status: null,
  },
  batchNotifyConfig: {
    webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    botId: "",
    mentions: "",
  },
  notifyPreview: null,
  notifyDraft: null,
  notifyError: "",
  notifyPreviewLoading: false,
  selected: {
    countryCode: "",
    dashboardUuid: "",
    cardId: "",
    ruleIndex: 0,
  },
};

export function setRoute(route) {
  const parsed = parseHashRoute(`#${route}`);
  state.route = parsed.path;
  state.routeQuery = parsed.query;
  window.location.hash = route;
}

export function parseHashRoute(hash = window.location.hash) {
  const raw = String(hash || "").replace(/^#/, "") || "/dashboard";
  const [path, queryString = ""] = raw.split("?");
  return {
    path: path || "/dashboard",
    query: Object.fromEntries(new URLSearchParams(queryString).entries()),
  };
}

export function getDashboards() {
  return state.inventory?.dashboards || [];
}

export function getCards(dashboard) {
  return dashboard?.cards || [];
}

export function findSelectedDashboard() {
  return getDashboards().find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || getDashboards()[0] || null;
}

export function findSelectedCard() {
  const dashboard = findSelectedDashboard();
  return getCards(dashboard).find((card) => String(card.cardId) === String(state.selected.cardId)) || getCards(dashboard)[0] || null;
}

export function findSelectedRule() {
  return state.rulesConfig?.rules?.[Number(state.selected.ruleIndex || 0)] || state.rulesConfig?.rules?.[0] || null;
}

export function json(value) {
  return JSON.stringify(value, null, 2);
}

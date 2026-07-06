export const state = {
  route: window.location.hash.replace(/^#/, "") || "/dashboard",
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
  batchMaxCards: 20,
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
  state.route = route;
  window.location.hash = route;
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

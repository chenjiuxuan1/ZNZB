import path from "node:path";
import { MetabaseInternalClient, parseInternalMetabaseUrl } from "./metabase-internal-client.mjs";
import { MetabasePublicClient, parsePublicDashboardUrl } from "./metabase-public-client.mjs";
import { resolveInternalMetabaseApiBaseUrl, resolvePublicMetabaseApiBaseUrl } from "./metabase-public-monitor.mjs";
import { readJsonFile, uniqueStrings, writeJsonFile } from "./utils.mjs";

export async function discoverPublicDashboards({
  inputFile,
  outputFile,
  sampleRows = 3,
  publicClientFactory = (ref) => new MetabasePublicClient({
    baseUrl: resolvePublicMetabaseApiBaseUrl(ref.baseUrl),
    requestTimeoutSeconds: 30,
  }),
  internalClientFactory = (ref) => new MetabaseInternalClient({
    baseUrl: resolveInternalMetabaseApiBaseUrl(ref.baseUrl),
    requestTimeoutSeconds: 30,
  }),
}) {
  const input = await readJsonFile(path.resolve(inputFile));
  const dashboardRefs = extractPublicDashboardRefs(input);
  const internalRefs = extractInternalMetabaseRefs(input);
  const dashboards = [];
  const sourceErrors = [];

  for (const ref of dashboardRefs) {
    const client = publicClientFactory(ref);
    const dashboard = await client.getDashboard(ref.uuid);
    const cards = extractCards(dashboard);
    const sampledCards = [];

    for (const card of cards) {
      sampledCards.push(await sampleCard(client, ref, card, sampleRows));
    }

    dashboards.push({
      country: ref.country || null,
      countryCode: ref.country?.code,
      countryName: ref.country?.name,
      timezone: ref.country?.timezone,
      access: "public",
      sourcePanelId: ref.sourcePanelId,
      sourcePanelTitle: ref.sourcePanelTitle,
      title: dashboard.name || dashboard.title || ref.sourcePanelTitle,
      uuid: ref.uuid,
      url: ref.url,
      parameters: summarizeParameters(dashboard.parameters || []),
      dashcardCount: dashboard.dashcards?.length || 0,
      cardCount: cards.length,
      cards: sampledCards,
    });
  }

  for (const ref of internalRefs) {
    const client = internalClientFactory(ref);
    try {
      dashboards.push(...await discoverInternalDashboards(client, ref, sampleRows));
    } catch (error) {
      sourceErrors.push({
        countryCode: ref.country?.code,
        countryName: ref.country?.name,
        sourcePanelId: ref.sourcePanelId,
        sourcePanelTitle: ref.sourcePanelTitle,
        sourceType: ref.type,
        sourceId: ref.id,
        url: ref.url,
        error: error.message,
      });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    country: input.country || null,
    sourceDashboard: {
      title: input.title,
      uid: input.uid,
    },
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, item) => sum + item.cardCount, 0),
    sourceErrorCount: sourceErrors.length,
    sourceErrors,
    dashboards,
  };

  if (outputFile) {
    await writeJsonFile(path.resolve(outputFile), summary);
  }

  return summary;
}

export function extractPublicDashboardRefs(discoveredPanels) {
  const refs = [];

  for (const panel of discoveredPanels.panels || []) {
    for (const link of panel.links || []) {
      const parsed = parsePublicDashboardUrl(link.url);
      if (!parsed) {
        continue;
      }
      refs.push({
        ...parsed,
        country: discoveredPanels.country || null,
        sourcePanelId: panel.id,
        sourcePanelTitle: panel.title,
      });
    }
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.baseUrl}:${ref.uuid}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function extractInternalMetabaseRefs(discoveredPanels) {
  const refs = [];

  for (const panel of discoveredPanels.panels || []) {
    for (const link of panel.links || []) {
      if (parsePublicDashboardUrl(link.url)) {
        continue;
      }
      const parsed = parseInternalMetabaseUrl(link.url);
      if (!parsed) {
        continue;
      }
      refs.push({
        ...parsed,
        country: discoveredPanels.country || null,
        sourcePanelId: panel.id,
        sourcePanelTitle: panel.title,
      });
    }
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.baseUrl}:${ref.type}:${ref.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractCards(dashboard) {
  return (dashboard.dashcards || [])
    .filter((dashcard) => dashcard.card_id && dashcard.card?.name)
    .map((dashcard) => ({
      dashcardId: dashcard.id,
      cardId: dashcard.card_id,
      title: dashcard.card.name,
      display: dashcard.card.display,
      dimensions: dashcard.card.visualization_settings?.["graph.dimensions"] || [],
      metrics: dashcard.card.visualization_settings?.["graph.metrics"] || [],
      parameterMappings: dashcard.parameter_mappings || [],
    }));
}

async function sampleCard(client, dashboardRef, card, sampleRows) {
  try {
    const rows = await client.queryDashcardJson({
      cardId: card.cardId,
      dashboardUuid: dashboardRef.uuid,
      dashboardId: dashboardRef.dashboardId,
      dashcardId: card.dashcardId,
    });
    const normalizedRows = Array.isArray(rows) ? rows : [];
    return {
      ...card,
      rowCount: normalizedRows.length,
      columns: inferColumns(normalizedRows),
      sampleRows: normalizedRows.slice(0, sampleRows),
      queryStatus: "ok",
    };
  } catch (error) {
    return {
      ...card,
      rowCount: null,
      columns: [],
      sampleRows: [],
      queryStatus: "error",
      error: error.message,
    };
  }
}

async function discoverInternalDashboards(client, ref, sampleRows) {
  const dashboardRefs = ref.type === "dashboard"
    ? [{ ...ref, dashboardId: ref.id, url: ref.url }]
    : await discoverDashboardsFromCollection(client, ref);
  const dashboards = [];

  for (const dashboardRef of dashboardRefs) {
    const dashboard = await client.getDashboard(dashboardRef.dashboardId);
    const cards = extractCards(dashboard);
    const sampledCards = [];

    for (const card of cards) {
      sampledCards.push(await sampleCard(client, dashboardRef, card, sampleRows));
    }

    dashboards.push({
      country: ref.country || null,
      countryCode: ref.country?.code,
      countryName: ref.country?.name,
      timezone: ref.country?.timezone,
      access: "internal",
      sourcePanelId: ref.sourcePanelId,
      sourcePanelTitle: ref.sourcePanelTitle,
      title: dashboard.name || dashboard.title || dashboardRef.title || ref.sourcePanelTitle,
      dashboardId: String(dashboardRef.dashboardId),
      uuid: `internal-${dashboardRef.dashboardId}`,
      url: dashboardRef.url || `${ref.baseUrl}/dashboard/${dashboardRef.dashboardId}`,
      sourceUrl: ref.url,
      sourceType: ref.type,
      parameters: summarizeParameters(dashboard.parameters || []),
      dashcardCount: dashboard.dashcards?.length || 0,
      cardCount: cards.length,
      cards: sampledCards,
    });
  }

  return dashboards;
}

async function discoverDashboardsFromCollection(client, ref) {
  const dashboards = [];
  const visitedCollections = new Set();

  async function visit(collectionId) {
    if (visitedCollections.has(collectionId)) {
      return;
    }
    visitedCollections.add(collectionId);

    const response = await client.getCollectionItems(collectionId);
    const items = normalizeCollectionItems(response);
    for (const item of items) {
      const model = String(item.model || item.type || "").toLowerCase();
      if (model === "dashboard") {
        dashboards.push({
          ...ref,
          dashboardId: String(item.id),
          title: item.name || item.title,
          url: item.url || `${ref.baseUrl}/dashboard/${item.id}`,
        });
      }
      if (model === "collection") {
        await visit(String(item.id));
      }
    }
  }

  await visit(ref.id);
  return dashboards;
}

function normalizeCollectionItems(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.items)) {
    return response.items;
  }
  return [];
}

function summarizeParameters(parameters) {
  return parameters.map((parameter) => ({
    id: parameter.id,
    name: parameter.name,
    type: parameter.type,
    default: parameter.default,
    isMultiSelect: parameter.isMultiSelect || false,
  }));
}

function inferColumns(rows) {
  return uniqueStrings(rows.flatMap((row) => Object.keys(row || {})));
}

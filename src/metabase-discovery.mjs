import path from "node:path";
import { MetabasePublicClient, parsePublicDashboardUrl } from "./metabase-public-client.mjs";
import { readJsonFile, uniqueStrings, writeJsonFile } from "./utils.mjs";

export async function discoverPublicDashboards({ inputFile, outputFile, sampleRows = 3 }) {
  const input = await readJsonFile(path.resolve(inputFile));
  const dashboardRefs = extractPublicDashboardRefs(input);
  const dashboards = [];

  for (const ref of dashboardRefs) {
    const client = new MetabasePublicClient({
      baseUrl: ref.baseUrl,
      requestTimeoutSeconds: 30,
    });
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

  const summary = {
    generatedAt: new Date().toISOString(),
    country: input.country || null,
    sourceDashboard: {
      title: input.title,
      uid: input.uid,
    },
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, item) => sum + item.cardCount, 0),
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

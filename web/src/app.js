import { apiGet } from "./api.js";
import { parseHashRoute, setRoute, state } from "./state.js";
import { renderCountries } from "./views/countries.js?v=20260706-ui16";
import { renderDashboard } from "./views/dashboard.js?v=20260706-ui16";
import { renderInventory } from "./views/inventory.js?v=20260707-cn-source2";
import { renderNotifyPreview } from "./views/notify-preview.js?v=20260706-ui16";
import { renderRules } from "./views/rules.js?v=20260706-ui16";
import { renderSandbox } from "./views/sandbox.js?v=20260707-sandbox-country";
import { renderBatchCheck } from "./views/batch-check.js?v=20260708-metabase-schedule";
import { renderWattrelAlerts } from "./views/wattrel-alerts.js?v=20260708-wattrel-page";
import { renderQualityRuleGeneration } from "./views/quality-rule-generation.js?v=20260708-quality-generation";
import { renderDsScheduler } from "./views/ds-scheduler.js?v=20260724-ds-notify";

const routes = [
  { path: "/dashboard", label: "总览", short: "总", render: renderDashboard },
  { path: "/countries", label: "国家配置", short: "国", render: renderCountries },
  { path: "/inventory", label: "看板与卡片", short: "板", render: renderInventory },
  { path: "/rules", label: "规则配置", short: "规", render: renderRules },
  { path: "/sandbox", label: "规则试跑", short: "试", render: renderSandbox },
  { path: "/batch-check", label: "Metabase 定时巡检", short: "巡", render: renderBatchCheck },
  { path: "/wattrel-alerts", label: "Wattrel告警", short: "告", render: renderWattrelAlerts },
  { path: "/quality-rule-generation", label: "智能告警生成", short: "生", render: renderQualityRuleGeneration },
  { path: "/notify-preview", label: "通知预览", short: "通", render: renderNotifyPreview },
  { path: "/ds-scheduler", label: "DS调度监控", short: "度", render: renderDsScheduler },
];

window.addEventListener("hashchange", () => {
  const parsed = parseHashRoute();
  state.route = parsed.path;
  state.routeQuery = parsed.query;
  render();
});

await loadData();
render();

export async function loadData() {
  const [summary, countries, rulesConfig, batchSchedule] = await Promise.all([
    apiGet("/api/summary"),
    apiGet("/api/countries"),
    apiGet("/api/rules"),
    apiGet("/api/batch-schedule").catch(() => null),
  ]);
  state.summary = summary;
  state.countries = countries;
  state.rulesConfig = rulesConfig;
  state.batchSchedule = batchSchedule;
  if (batchSchedule) {
    state.batchNotifyConfig = {
      webhookUrl: batchSchedule.webhookUrl || state.batchNotifyConfig.webhookUrl,
      botId: batchSchedule.botId || state.batchNotifyConfig.botId,
      mentions: batchSchedule.mentions || state.batchNotifyConfig.mentions,
    };
    if (!state.selected.countryCode && batchSchedule.countryCode) {
      state.selected.countryCode = batchSchedule.countryCode;
    }
    if (!state.selected.dashboardUuid && batchSchedule.dashboardUuid) {
      state.selected.dashboardUuid = batchSchedule.dashboardUuid;
    }
  }
  loadLazyData();
}

let lazyDataLoaded = false;
async function loadLazyData() {
  if (lazyDataLoaded) {
    return;
  }
  lazyDataLoaded = true;
  try {
    const [inventory, batchHistory] = await Promise.all([
      apiGet("/api/inventory"),
      apiGet("/api/batch-history?limit=200").catch(() => ({ runs: [] })),
    ]);
    state.inventory = inventory;
    state.batchHistory = batchHistory;
  } catch (error) {
    console.warn("Lazy data load failed:", error);
  }
}

export async function ensureInventoryLoaded() {
  if (state.inventory) {
    return state.inventory;
  }
  await loadLazyData();
  return state.inventory;
}

export function render() {
  const route = routes.find((item) => item.path === state.route) || routes[0];
  const app = document.querySelector("#app");
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand-block">
          <div class="brand-mark">值</div>
          <div>
            <div class="brand">值班平台</div>
            <div class="brand-subtitle">配置 · 巡检 · 通知工作台</div>
          </div>
        </div>
        <nav class="nav">
          ${routes.map((item) => `
            <button class="${item.path === route.path ? "active" : ""}" data-route="${item.path}">
              <span class="nav-icon">${item.short}</span>
              <span>${item.label}</span>
            </button>
          `).join("")}
        </nav>
      </aside>
      <main class="main" id="main"></main>
    </div>
  `;
  app.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => setRoute(button.dataset.route));
  });
  route.render(document.querySelector("#main"), { reload: refresh });
}

async function refresh() {
  await loadData();
  render();
}

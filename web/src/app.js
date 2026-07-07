import { apiGet } from "./api.js";
import { setRoute, state } from "./state.js";
import { renderCountries } from "./views/countries.js?v=20260706-ui16";
import { renderDashboard } from "./views/dashboard.js?v=20260706-ui16";
import { renderInventory } from "./views/inventory.js?v=20260706-ui16";
import { renderNotifyPreview } from "./views/notify-preview.js?v=20260706-ui16";
import { renderRules } from "./views/rules.js?v=20260706-ui16";
import { renderSandbox } from "./views/sandbox.js?v=20260706-ui16";
import { renderBatchCheck } from "./views/batch-check.js?v=20260707-schedule1";

const routes = [
  { path: "/dashboard", label: "总览", render: renderDashboard },
  { path: "/countries", label: "国家配置", render: renderCountries },
  { path: "/inventory", label: "看板与卡片", render: renderInventory },
  { path: "/rules", label: "规则配置", render: renderRules },
  { path: "/sandbox", label: "规则试跑", render: renderSandbox },
  { path: "/batch-check", label: "批量巡检", render: renderBatchCheck },
  { path: "/notify-preview", label: "通知预览", render: renderNotifyPreview },
];

window.addEventListener("hashchange", () => {
  state.route = window.location.hash.replace(/^#/, "") || "/dashboard";
  render();
});

await loadData();
render();

export async function loadData() {
  const [summary, countries, inventory, rulesConfig, batchSchedule] = await Promise.all([
    apiGet("/api/summary"),
    apiGet("/api/countries"),
    apiGet("/api/inventory"),
    apiGet("/api/rules"),
    apiGet("/api/batch-schedule").catch(() => null),
  ]);
  state.summary = summary;
  state.countries = countries;
  state.inventory = inventory;
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
}

export function render() {
  const route = routes.find((item) => item.path === state.route) || routes[0];
  const app = document.querySelector("#app");
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">值班平台</div>
        <div class="brand-subtitle">配置 + 离线试跑工作台</div>
        <nav class="nav">
          ${routes.map((item) => `
            <button class="${item.path === route.path ? "active" : ""}" data-route="${item.path}">
              ${item.label}
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

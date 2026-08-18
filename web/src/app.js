import { apiGet } from "./api.js";
import { parseHashRoute, setRoute, state } from "./state.js";
import { renderCountries } from "./views/countries.js?v=20260706-ui16";
import { renderDashboard } from "./views/dashboard.js?v=20260706-ui16";
import { renderInventory } from "./views/inventory.js?v=20260811-manual-discovery2";
import { renderNotifyPreview } from "./views/notify-preview.js?v=20260706-ui16";
import { renderRules } from "./views/rules.js?v=20260706-ui16";
import { renderSandbox } from "./views/sandbox.js?v=20260707-sandbox-country";
import { renderBatchCheck } from "./views/batch-check.js?v=20260804-progress-poll";
import { renderFluctuationVisual } from "./views/fluctuation-visual.js?v=20260806-filtered-run-load";
import { renderWattrelAlerts } from "./views/wattrel-alerts.js?v=20260708-wattrel-page";
import { renderQualityRuleGeneration } from "./views/quality-rule-generation.js?v=20260708-quality-generation";
import { renderDsScheduler } from "./views/ds-scheduler.js?v=20260725-ds-v8";
import { renderHiveScheduler } from "./views/hive-scheduler.js?v=20260811-hive-v1";
import { renderDsFailureLogs } from "./views/ds-failure-logs.js?v=20260818-v9";

const routes = [
  { path: "/dashboard", label: "总览", short: "总", render: renderDashboard },
  { path: "/countries", label: "国家配置", short: "国", render: renderCountries },
  { path: "/inventory", label: "看板与卡片", short: "板", render: renderInventory },
  { path: "/rules", label: "规则配置", short: "规", render: renderRules },
  { path: "/sandbox", label: "规则试跑", short: "试", render: renderSandbox },
  { path: "/batch-check", label: "定时巡检", short: "巡", render: renderBatchCheck },
  { path: "/fluctuation-visual", label: "波动图谱", short: "波", render: renderFluctuationVisual },
  { path: "/wattrel-alerts", label: "Wattrel告警", short: "告", render: renderWattrelAlerts },
  { path: "/quality-rule-generation", label: "智能告警生成", short: "生", render: renderQualityRuleGeneration },
  { path: "/notify-preview", label: "通知预览", short: "通", render: renderNotifyPreview },
  { path: "/ds-scheduler", label: "DS调度监控", short: "度", render: renderDsScheduler },
  { path: "/ds-failure-logs", label: "DS失败任务日志", short: "错", render: renderDsFailureLogs },
  { path: "/hive-scheduler", label: "HIVE调度监控", short: "仓", render: renderHiveScheduler },
];

window.addEventListener("hashchange", () => {
  const parsed = parseHashRoute();
  state.route = parsed.path;
  state.routeQuery = parsed.query;
  render();
});

// Render the shell first. Inventory and history files can be large, and waiting for
// them here used to leave users with a completely blank page during startup.
render();
void loadInitialData();

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
  applyBatchSchedule(batchSchedule);
}

async function loadInitialData() {
  const historyRunId = ["/batch-check", "/fluctuation-visual"].includes(state.route)
    ? (state.routeQuery?.historyRunId || state.routeQuery?.runId || "")
    : "";
  if (historyRunId) {
    state.batchHistoryStatus = {
      type: "loading",
      title: "正在加载巡检历史详情",
      detail: "只读取当前链接对应的一次巡检记录。",
    };
  }

  // Small configuration responses improve the first useful render without waiting
  // for inventory, rules, or the full one-week history file.
  const critical = await Promise.allSettled([
    apiGet("/api/countries"),
    apiGet("/api/batch-schedule"),
    historyRunId
      ? apiGet(`/api/batch-history?runId=${encodeURIComponent(historyRunId)}`)
      : Promise.resolve(null),
  ]);
  if (critical[0].status === "fulfilled") state.countries = critical[0].value;
  if (critical[1].status === "fulfilled") applyBatchSchedule(critical[1].value);
  if (critical[2].status === "fulfilled") {
    state.batchHistory = critical[2].value;
    state.batchHistoryStatus = null;
  } else if (historyRunId) {
    state.batchHistoryStatus = {
      type: "error",
      title: "巡检历史详情读取失败",
      detail: critical[2].reason?.message || "请稍后刷新重试。",
    };
  }
  if (state.route !== "/hive-scheduler") render();

  const deferred = await Promise.allSettled([
    apiGet("/api/summary"),
    apiGet("/api/inventory"),
    apiGet("/api/rules"),
    Promise.resolve(null),
  ]);
  if (deferred[0].status === "fulfilled") state.summary = deferred[0].value;
  if (deferred[1].status === "fulfilled") state.inventory = deferred[1].value;
  if (deferred[2].status === "fulfilled") state.rulesConfig = deferred[2].value;
  if (state.route !== "/hive-scheduler") render();
}

function applyBatchSchedule(batchSchedule) {
  state.batchSchedule = batchSchedule;
  if (!batchSchedule) return;
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

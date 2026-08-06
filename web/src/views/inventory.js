import { apiDelete, apiGet, apiPost } from "../api.js";
import { getDashboards, isDashboardExecutable, state } from "../state.js";
import { compactDashboardUrl, compactList, countryLabel, escapeHtml, json } from "../view-utils.js";

let discoveryStatus = null;
let discoveryProgress = null;

export function renderInventory(root) {
  const dashboards = getDashboards();
  const countries = state.countries?.countries || [];
  const configuredCountryCodes = countries.map((country) => country.code).filter(Boolean);
  const inventoryCountryCodes = dashboards.map((dashboard) => dashboard.countryCode || dashboard.country?.code).filter(Boolean);
  const countryCodes = [...new Set([...configuredCountryCodes, ...inventoryCountryCodes])];
  const selectedCountry = state.selected.countryCode || countryCodes[0] || "";
  const countryDashboards = dashboards.filter((dashboard) => (dashboard.countryCode || dashboard.country?.code) === selectedCountry);
  const selectedDashboard = countryDashboards.find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || countryDashboards[0] || null;
  const cards = selectedDashboard?.cards || [];

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">看板与卡片</h1>
        <p class="page-note">按国家查看 Metabase inventory。已标记来源表示业务要求巡检的看板范围；可执行卡片表示系统已经能通过接口读取并参与异常判断。</p>
      </div>
      <div class="button-group">
        <button id="discover-country-dashboards" ${selectedCountry ? "" : "disabled"}>重新发现当前国家看板</button>
        <button class="primary" id="discover-all-dashboards" ${discoveryProgress?.status === "running" ? "disabled aria-busy=\"true\"" : ""}>${discoveryProgress?.status === "running" ? "发现进行中..." : "一键发现六国看板"}</button>
      </div>
    </div>
    <form class="panel compact" id="manual-dashboard-form">
      <h2 class="panel-title">手动添加 Metabase 看板</h2>
      <p class="muted">添加后仅显示为“待发现”，不会访问 Metabase；请选择该看板后再单独发现卡片。</p>
      <div class="form-grid">
        <label>国家<select name="countryCode" required>
          ${countries.map((country) => `<option value="${escapeHtml(country.code)}" ${country.code === selectedCountry ? "selected" : ""}>${escapeHtml(countryLabel(country.code, countries))}</option>`).join("")}
        </select></label>
        <label>看板名称<input name="title" required placeholder="例如：核心经营看板"></label>
        <label>看板链接<input name="url" required placeholder="https://.../public/dashboard/... 或 /dashboard/..."></label>
        <div class="form-actions"><button class="primary" type="submit">添加为待发现</button></div>
      </div>
    </form>
    ${discoveryStatus ? `<div class="sandbox-status ${discoveryStatus.type}"><strong>${escapeHtml(discoveryStatus.title)}</strong><span>${escapeHtml(discoveryStatus.detail)}</span></div>` : ""}
    ${renderAllDiscoveryProgress()}
    <div class="notice">
      <strong>怎么读</strong>
      <span>先选国家，再选看板；右侧会展示该看板下的卡片、字段、样例行和查询状态。用于确认“规则会检查哪些卡片”。</span>
    </div>
    <div class="country-tabs">
      ${countryCodes.map((code) => `
        <button class="${code === selectedCountry ? "active" : ""}" data-country-code="${escapeHtml(code)}">
          ${escapeHtml(countryLabel(code, countries))}
          <span>可执行 ${dashboards.filter((dashboard) => dashboard.countryCode === code && isDashboardExecutable(dashboard)).length}</span>
          <small>全部 ${dashboards.filter((dashboard) => dashboard.countryCode === code).length}</small>
        </button>
      `).join("")}
    </div>
    <div class="inventory-layout">
      <section class="panel">
        <h2 class="panel-title">${escapeHtml(countryLabel(selectedCountry, countries))} 的看板</h2>
        <div class="dashboard-list">
          ${countryDashboards.map((dashboard) => `
            <button class="dashboard-row ${dashboard === selectedDashboard ? "selected" : ""}" data-dashboard-uuid="${escapeHtml(dashboard.uuid || "")}">
              <span>
                <strong>${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "-")}</strong>
                <small title="${escapeHtml(dashboard.url || "")}">${escapeHtml(compactDashboardUrl(dashboard.url))}</small>
              </span>
              ${isDashboardExecutable(dashboard)
                ? `<b class="badge ok">可执行 · ${dashboard.cards?.length || 0} 张卡片</b>`
                : `<b class="badge warn">待发现</b>`}
            </button>
          `).join("") || `<p class="muted">该国家暂无看板。</p>`}
        </div>
      </section>
      <section class="panel">
        ${selectedDashboard ? renderDashboardDetail(selectedDashboard, cards) : `<p class="muted">请选择一个看板。</p>`}
      </section>
    </div>
  `;

  root.querySelectorAll("[data-country-code]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.countryCode = button.dataset.countryCode;
      state.selected.dashboardUuid = "";
      renderInventory(root);
    });
  });
  root.querySelectorAll("[data-dashboard-uuid]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.dashboardUuid = button.dataset.dashboardUuid;
      renderInventory(root);
    });
  });
  root.querySelector("#manual-dashboard-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    discoveryStatus = { type: "loading", title: "正在添加看板", detail: "仅保存来源记录，不会执行 Metabase 发现。" };
    renderInventory(root);
    try {
      const added = await apiPost("/api/inventory/manual", Object.fromEntries(form.entries()));
      state.inventory = await apiGet("/api/inventory");
      state.selected.countryCode = added.countryCode;
      state.selected.dashboardUuid = added.uuid;
      discoveryStatus = { type: "success", title: "已添加为待发现", detail: "请选择该看板并点击“发现卡片”，完成后才会纳入巡检。" };
    } catch (error) {
      discoveryStatus = { type: "error", title: "添加看板失败", detail: error.payload?.errors?.join("；") || error.message };
    }
    renderInventory(root);
  });
  root.querySelector("#discover-one-dashboard")?.addEventListener("click", async () => {
    if (!selectedDashboard?.sourcePanelId) return;
    discoveryStatus = { type: "loading", title: "正在发现卡片", detail: `仅发现“${selectedDashboard.title || selectedDashboard.sourcePanelTitle}”，不会扫描其他看板。` };
    renderInventory(root);
    try {
      const result = await apiPost("/api/inventory/discover-one", {
        countryCode: selectedDashboard.countryCode,
        sourcePanelId: selectedDashboard.sourcePanelId,
      });
      state.inventory = await apiGet("/api/inventory");
      discoveryStatus = {
        type: "success",
        title: "卡片发现完成",
        detail: `已发现 ${result.discoveredDashboardCount || 0} 个看板，其中 ${result.executableDashboardCount || 0} 个可执行。`,
      };
    } catch (error) {
      discoveryStatus = { type: "error", title: "卡片发现失败", detail: error.payload?.errors?.join("；") || error.message };
    }
    renderInventory(root);
  });
  root.querySelector("#delete-dashboard")?.addEventListener("click", async () => {
    if (!selectedDashboard) return;
    const title = selectedDashboard.title || selectedDashboard.sourcePanelTitle || "该看板";
    if (!window.confirm(`确定删除“${title}”吗？删除后不会再展示，也不会进入手动或定时巡检。`)) return;
    discoveryStatus = { type: "loading", title: "正在删除看板", detail: "正在从运行时巡检范围中移除该看板。" };
    renderInventory(root);
    try {
      await apiDelete("/api/inventory/dashboard", {
        countryCode: selectedDashboard.countryCode || selectedDashboard.country?.code || "",
        dashboardUuid: selectedDashboard.uuid || "",
        sourcePanelId: selectedDashboard.sourcePanelId || "",
        dashboardId: selectedDashboard.dashboardId || "",
        url: selectedDashboard.url || selectedDashboard.sourceUrl || "",
      });
      state.inventory = await apiGet("/api/inventory");
      state.selected.dashboardUuid = "";
      discoveryStatus = { type: "success", title: "看板已删除", detail: "该看板已从展示清单和巡检范围中移除；后续定时巡检不会扫描它。" };
    } catch (error) {
      discoveryStatus = { type: "error", title: "删除看板失败", detail: error.payload?.errors?.join("；") || error.message };
    }
    renderInventory(root);
  });
  root.querySelector("#discover-country-dashboards")?.addEventListener("click", async () => {
    discoveryStatus = { type: "loading", title: "正在重新发现", detail: `正在读取 ${countryLabel(selectedCountry, countries)} 的内部 Metabase 看板和卡片。` };
    renderInventory(root);
    try {
      const result = await apiPost("/api/inventory/discover", { countryCode: selectedCountry });
      state.inventory = await apiGet("/api/inventory");
      state.selected.dashboardUuid = "";
      discoveryStatus = {
        type: "success",
        title: "看板发现完成",
        detail: `发现 ${result.discoveredDashboardCount || 0} 个看板，其中 ${result.executableDashboardCount || 0} 个可执行。`,
      };
    } catch (error) {
      discoveryStatus = {
        type: "error",
        title: "看板发现失败",
        detail: error.payload?.errors?.join("；") || error.message,
      };
    }
    renderInventory(root);
  });
  root.querySelector("#discover-all-dashboards")?.addEventListener("click", async () => {
    discoveryProgress = { status: "running", countries: [], currentCountryCode: "" };
    discoveryStatus = { type: "loading", title: "六国看板发现已启动", detail: "正在后台逐国读取 Metabase 看板和卡片；此页面不会因耗时任务断开。" };
    renderInventory(root);
    try {
      const started = await apiPost("/api/inventory/discover-all/start", {});
      if (!started.started) {
        discoveryStatus = { type: "loading", title: "六国看板发现进行中", detail: "已有发现任务正在后台执行，请稍候。" };
        renderInventory(root);
      }
      const result = await waitForAllDashboardDiscovery(root);
      if (result.status === "failed") {
        throw new Error(result.error || "Metabase 看板发现失败");
      }
      state.inventory = await apiGet("/api/inventory");
      state.selected.dashboardUuid = "";
      const failures = (result.result?.results || []).filter((item) => !item.ok);
      discoveryStatus = failures.length
        ? { type: "error", title: `完成 ${result.result.succeeded}/${result.result.total} 个国家`, detail: failures.map((item) => `${item.countryCode}：${item.error}`).join("；") }
        : { type: "success", title: "六国看板发现完成", detail: `已刷新 ${Math.max(0, (result.result.succeeded || 0) - (result.result.skipped || 0))} 个待发现国家，跳过 ${result.result.skipped || 0} 个已发现国家。` };
    } catch (error) {
      discoveryStatus = { type: "error", title: "六国看板发现失败", detail: error.payload?.errors?.join("；") || error.message };
    }
    discoveryProgress = null;
    renderInventory(root);
  });
}

async function waitForAllDashboardDiscovery(root) {
  for (;;) {
    const progress = await apiGet("/api/inventory/discover-all/progress");
    discoveryProgress = progress;
    renderInventory(root);
    if (progress.status !== "running") {
      return progress;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function renderAllDiscoveryProgress() {
  if (discoveryProgress?.status !== "running") return "";
  const countries = discoveryProgress.countries || [];
  const completed = countries.filter((item) => ["success", "skipped", "failed"].includes(item.status)).length;
  const total = Math.max((state.countries?.countries || []).length, countries.length);
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const current = countries.find((item) => item.status === "running");
  return `
    <section class="sub-panel schedule-progress-panel inventory-discovery-progress">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">看板发现进度</h2>
          <p class="muted">${escapeHtml(current ? `正在读取 ${current.countryName || current.countryCode} 的看板与卡片` : "正在准备下一个国家")}</p>
        </div>
        <span class="badge warn">${escapeHtml(completed)}/${escapeHtml(total || "-")}</span>
      </div>
      <div class="progress-track" aria-label="六国看板发现进度"><span style="width:${escapeHtml(percent)}%"></span></div>
      ${countries.length ? `<div class="schedule-progress-list">${countries.map((country) => `
        <article class="schedule-progress-item ${escapeHtml(country.status || "pending")}">
          <div><strong>${escapeHtml(country.countryName || country.countryCode || "-")}</strong><span>${escapeHtml(discoveryCountryDetail(country))}</span></div>
          <span class="badge ${escapeHtml(discoveryBadge(country.status))}">${escapeHtml(discoveryLabel(country.status))}</span>
        </article>
      `).join("")}</div>` : ""}
    </section>
  `;
}

function discoveryCountryDetail(country) {
  if (country.status === "running") return "正在发现 Metabase 看板和卡片";
  if (country.status === "success") return `发现 ${country.discoveredDashboardCount || 0} 个看板，可执行 ${country.executableDashboardCount || 0} 个`;
  if (country.status === "skipped") return "看板已完整发现，已跳过";
  return country.error || "等待发现";
}

function discoveryLabel(status) {
  return ({ running: "进行中", success: "完成", skipped: "已跳过", failed: "失败" })[status] || "等待中";
}

function discoveryBadge(status) {
  return ({ running: "warn", success: "ok", skipped: "ok", failed: "danger" })[status] || "idle";
}

function renderDashboardDetail(dashboard, cards) {
  const executable = isDashboardExecutable(dashboard);
  return `
    <div class="detail-header">
      <div>
        <h2 class="panel-title">${escapeHtml(dashboard.title || dashboard.sourcePanelTitle || "-")}</h2>
        <p class="muted">${escapeHtml(dashboard.countryName || dashboard.countryCode || "-")} · ${executable ? `${cards.length} 张卡片` : "待发现卡片"}</p>
      </div>
      <div class="button-group">
        ${dashboard.url ? `<a class="link-button" href="${escapeHtml(dashboard.url)}" target="_blank" rel="noreferrer">打开 Metabase</a>` : ""}
        <button class="danger" id="delete-dashboard" type="button">删除看板</button>
      </div>
    </div>
    ${executable ? `<div class="card-list">${cards.map((card) => renderCard(card)).join("")}</div>` : `
      <div class="source-notice">
        <span class="badge warn">已纳入巡检范围 · 待发现</span>
        <p>${escapeHtml(dashboard.pendingReason || "尚未取得 Metabase 卡片清单")}。完成内部 Metabase 发现后会自动变为可执行，无需再次录入看板。</p>
        ${dashboard.sourcePanelId != null ? `<button class="primary" id="discover-one-dashboard">发现卡片</button>` : ""}
      </div>
    `}
    ${executable ? `<details class="advanced compact">
      <summary>高级：查看首张卡片 sampleRows</summary>
      <pre class="code">${escapeHtml(json(cards[0]?.sampleRows || []))}</pre>
    </details>` : ""}
  `;
}

function renderCard(card) {
  return `
    <article class="card-row">
      <div>
        <h3>${escapeHtml(card.title || "-")}</h3>
        <p>${escapeHtml(compactList(card.columns || [], 6))}</p>
      </div>
      <div class="card-meta">
        <span>cardId ${escapeHtml(card.cardId || "-")}</span>
        <span>dashcardId ${escapeHtml(card.dashcardId || "-")}</span>
        <span class="badge ${card.queryStatus === "ok" ? "ok" : "warn"}">${escapeHtml(card.queryStatus || "unknown")}</span>
      </div>
    </article>
  `;
}

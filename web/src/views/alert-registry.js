import { apiDelete, apiGet, apiPost, apiPut } from "../api.js";
import { escapeHtml } from "../view-utils.js";

/**
 * 告警注册表：动态配置 / 新增 / 测试 n8n 与夜莺等告警条目。
 *
 * 能力：
 *   1. 列表展示所有告警条目（名称/国家/来源/触发/状态/命令）
 *   2. 新增 / 编辑 / 删除 / 启停
 *   3. 每条「▶ 测试」：平台直接执行（SSH dry-run 或本地命令），结果展示 stdout/stderr/exitCode
 *   4. 「测试命令」：新增前先用任意命令验证（动态添加测试代码入口）
 */
export function renderAlertRegistry(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">告警注册</h1>
        <p class="page-note">把 n8n / 夜莺等告警抽象为可配置条目，动态新增与测试。测试走 dry-run，不发送通知。</p>
      </div>
      <div class="header-actions">
        <button class="primary" id="ar-refresh">刷新</button>
        <button id="ar-new">+ 新增告警</button>
      </div>
    </div>
    <section class="panel">
      <div id="ar-list"></div>
    </section>
    <section class="panel" id="ar-test-panel" style="display:none">
      <div class="panel-title">测试结果</div>
      <div id="ar-test-output"></div>
    </section>
    <section class="panel">
      <div class="panel-title">多国一致性校验 · 最近 200 次结果</div>
      <div class="panel-note">由「多国一致性校验告警」n8n 工作流每小时回写；只展示有异常的国家，可按国家筛选与翻页。定时默认每小时 55 分，可在下方调整。</div>
      <div class="mc-controls">
        <span class="mc-schedule-label mc-controls-title">⏰ 定时</span>
        <span class="mc-schedule-label">每小时</span>
        <input type="number" id="mc-schedule-minute" min="0" max="59" value="55" class="mc-schedule-input" />
        <span class="mc-schedule-label">分</span>
        <button class="mc-page-btn" id="mc-schedule-save">保存</button>
        <span class="mc-schedule-status" id="mc-schedule-status"></span>
        <span class="mc-controls-divider"></span>
        <label class="mc-filter-check"><input type="checkbox" id="mc-only-alert" /> 只看异常</label>
        <select id="mc-country-filter"><option value="">全部国家</option></select>
        <div class="mc-pager" id="mc-pager"></div>
      </div>
      <details class="mc-notify" id="mc-notify-panel">
        <summary>📞 电话通知配置（同国连续 N 次异常未处理，自动打电话给对应联系人）</summary>
        <div class="mc-notify-body" id="mc-notify-body"></div>
      </details>
      <details class="mc-notify" id="mc-group-panel">
        <summary>📢 发送群设置（告警发送群 chat id + 各国家负责人，有报警时末尾 @ 对应负责人）</summary>
        <div class="mc-notify-body" id="mc-group-body"></div>
      </details>
      <div id="mc-results"></div>
    </section>
  `;

  root.querySelector("#ar-refresh").addEventListener("click", () => {
    loadList(root);
    loadMcResults(root);
  });
  root.querySelector("#ar-new").addEventListener("click", () => openEditor(root, null));

  loadList(root);
  loadMcResults(root);
}

// 多国校验结果页状态（筛选 + 分页）
const mcState = { country: "", onlyAlert: false, page: 1, pageSize: 5, runs: [], scheduleMinute: 55 };

/** 加载多国一致性校验结果（筛选 + 分页）。 */
async function loadMcResults(root) {
  const el = root.querySelector("#mc-results");
  if (!el) return;
  el.innerHTML = `<div class="mc-loading">⏳ 正在加载校验结果…</div>`;
  let runs;
  try {
    runs = await apiGet("/api/multi-country/check-results");
  } catch (error) {
    el.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    return;
  }
  mcState.runs = Array.isArray(runs) ? runs : [];
  // 绑定筛选控件事件
  const onlyAlert = root.querySelector("#mc-only-alert");
  if (onlyAlert) {
    onlyAlert.checked = mcState.onlyAlert;
    onlyAlert.onchange = () => { mcState.onlyAlert = onlyAlert.checked; mcState.page = 1; renderMcResults(root); };
  }
  const countrySel2 = root.querySelector("#mc-country-filter");
  if (countrySel2) {
    countrySel2.onchange = () => { mcState.country = countrySel2.value; mcState.page = 1; renderMcResults(root); };
  }
  // 更新国家筛选下拉（去重 + 按出现顺序）
  const countrySel = root.querySelector("#mc-country-filter");
  const countrySet = new Set();
  mcState.runs.forEach((run) => (run.countries || []).forEach((c) => { if ((c.mismatches || []).length > 0) countrySet.add(c.label || c.code || ""); }));
  if (countrySel) {
    countrySel.innerHTML = `<option value="">全部国家</option>` + [...countrySet].map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    countrySel.value = mcState.country;
  }
  renderMcResults(root);
  loadMcSchedule(root);
  loadMcNotify(root);
  loadMcGroup(root);
}

/** 多国校验 · 电话通知配置状态。 */
const mcNotifyState = { countries: {}, saving: false };

/** 加载并绑定多国校验电话通知配置（每国联系人 + 电话/群消息开关 + 电话阈值）。 */
async function loadMcNotify(root) {
  const body = root.querySelector("#mc-notify-body");
  if (!body) return;
  body.innerHTML = `<div class="mc-loading">⏳ 正在加载通知配置…</div>`;
  let cfg;
  try {
    cfg = await apiGet("/api/multi-country/notify");
  } catch (e) {
    body.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(e.message || String(e))}</span></div>`;
    return;
  }
  const countries = (cfg && cfg.countries) || {};
  mcNotifyState.countries = countries;
  const countryNames = { cn: "中国", id: "印尼", mx: "墨西哥", th: "泰国", ph: "菲律宾", pk: "巴基斯坦" };
  const order = ["cn", "id", "mx", "th", "ph", "pk"];
  const rows = order
    .filter((code) => countries[code])
    .map((code) => {
      const c = countries[code];
      return `
        <div class="mc-notify-row" data-code="${code}">
          <span class="mc-notify-country">${escapeHtml(countryNames[code] || code)}</span>
          <input type="text" class="mc-notify-contacts" data-code="${code}" value="${escapeHtml((c.contacts || []).join(","))}" placeholder="手机号/夜莺用户名，多个用逗号分隔" />
          <label class="mc-notify-toggle"><input type="checkbox" data-code="${code}" data-field="phone" ${c.phone !== false ? "checked" : ""} /> 电话</label>
          <label class="mc-notify-toggle"><input type="checkbox" data-code="${code}" data-field="group" ${c.group !== false ? "checked" : ""} /> 群消息</label>
          <label class="mc-notify-threshold">连续 <input type="number" class="mc-notify-num" data-code="${code}" data-field="strikeThreshold" min="1" max="99" value="${c.strikeThreshold || 6}" /> 次打</label>
        </div>
      `;
    })
    .join("");
  body.innerHTML = `
    <div class="mc-notify-rows">${rows}</div>
    <div class="mc-notify-actions">
      <button class="mc-page-btn" id="mc-notify-save">保存通知配置</button>
      <span class="mc-schedule-status" id="mc-notify-status"></span>
    </div>`;
  const saveBtn = root.querySelector("#mc-notify-save");
  const status = root.querySelector("#mc-notify-status");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (mcNotifyState.saving) return;
      mcNotifyState.saving = true;
      if (status) { status.textContent = "保存中…"; status.className = "mc-schedule-status"; }
      const next = {};
      for (const code of order) {
        if (!countries[code]) continue;
        const row = body.querySelector(`.mc-notify-row[data-code="${code}"]`);
        if (!row) continue;
        const contacts = (row.querySelector(".mc-notify-contacts")?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
        const phone = row.querySelector('input[data-field="phone"]')?.checked ?? countries[code].phone !== false;
        const group = row.querySelector('input[data-field="group"]')?.checked ?? countries[code].group !== false;
        const threshold = Number(row.querySelector('input[data-field="strikeThreshold"]')?.value) || 6;
        next[code] = { contacts, phone, group, strikeThreshold: threshold };
      }
      try {
        const res = await apiPut("/api/multi-country/notify", { countries: next });
        if (res && res.ok) {
          mcNotifyState.countries = res.countries || next;
          if (status) { status.textContent = "✅ 已保存通知配置"; status.className = "mc-schedule-status ok"; }
        } else {
          if (status) { status.textContent = "❌ 保存失败"; status.className = "mc-schedule-status error"; }
        }
      } catch (e) {
        if (status) { status.textContent = `❌ ${e.message || String(e)}`; status.className = "mc-schedule-status error"; }
      }
      mcNotifyState.saving = false;
    };
  }
}

/** 多国校验 · 发送群配置状态（群 chat id + 各国家负责人 @ 清单）。 */
const mcGroupState = { saving: false };

/** 加载并绑定多国校验发送群配置（发送群 chat id + 各国家负责人，有报警时末尾 @ 负责人）。 */
async function loadMcGroup(root) {
  const body = root.querySelector("#mc-group-body");
  if (!body) return;
  body.innerHTML = `<div class="mc-loading">⏳ 正在加载发送群配置…</div>`;
  let cfg;
  try {
    cfg = await apiGet("/api/multi-country/group");
  } catch (e) {
    body.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(e.message || String(e))}</span></div>`;
    return;
  }
  const chatId = cfg && cfg.chatId != null ? cfg.chatId : -1073807215;
  const owners = (cfg && cfg.owners) || {};
  const countryNames = { cn: "中国", id: "印尼", mx: "墨西哥", th: "泰国", ph: "菲律宾", pk: "巴基斯坦" };
  const order = ["cn", "id", "mx", "th", "ph", "pk"];
  const rows = order
    .map((code) => `
      <div class="mc-notify-row" data-code="${code}">
        <span class="mc-notify-country">${escapeHtml(countryNames[code] || code)}</span>
        <input type="text" class="mc-group-owners" data-code="${code}" value="${escapeHtml((owners[code] || []).join(","))}" placeholder="KN 用户名（如 xxx@kn.group），多个用逗号分隔" />
      </div>
    `)
    .join("");
  body.innerHTML = `
    <div class="mc-group-chat">
      <label class="mc-group-chat-label">告警发送群 chat id：</label>
      <input type="text" class="mc-group-chatid" value="${escapeHtml(String(chatId))}" placeholder="如 -1073807215" />
      <span class="mc-group-chat-hint">群 chat id（负数表示群）。修改后告警将发送到该群。</span>
    </div>
    <div class="mc-notify-rows">${rows}</div>
    <div class="mc-notify-actions">
      <button class="mc-page-btn" id="mc-group-save">保存发送群设置</button>
      <span class="mc-schedule-status" id="mc-group-status"></span>
    </div>`;
  const saveBtn = root.querySelector("#mc-group-save");
  const status = root.querySelector("#mc-group-status");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (mcGroupState.saving) return;
      mcGroupState.saving = true;
      if (status) { status.textContent = "保存中…"; status.className = "mc-schedule-status"; }
      const nextOwners = {};
      for (const code of order) {
        const row = body.querySelector(`.mc-notify-row[data-code="${code}"]`);
        if (!row) continue;
        const list = (row.querySelector(".mc-group-owners")?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
        nextOwners[code] = list;
      }
      const nextChatId = Number(body.querySelector(".mc-group-chatid")?.value);
      if (!Number.isFinite(nextChatId)) {
        if (status) { status.textContent = "❌ chat id 必须是数字"; status.className = "mc-schedule-status error"; }
        mcGroupState.saving = false;
        return;
      }
      try {
        const res = await apiPut("/api/multi-country/group", { chatId: nextChatId, owners: nextOwners });
        if (res && res.ok) {
          if (status) { status.textContent = "✅ 已保存发送群设置"; status.className = "mc-schedule-status ok"; }
        } else {
          if (status) { status.textContent = "❌ 保存失败"; status.className = "mc-schedule-status error"; }
        }
      } catch (e) {
        if (status) { status.textContent = `❌ ${e.message || String(e)}`; status.className = "mc-schedule-status error"; }
      }
      mcGroupState.saving = false;
    };
  }
}

async function loadMcSchedule(root) {
  const input = root.querySelector("#mc-schedule-minute");
  const saveBtn = root.querySelector("#mc-schedule-save");
  const status = root.querySelector("#mc-schedule-status");
  if (!input || !saveBtn) return;
  try {
    const s = await apiGet("/api/multi-country/schedule");
    if (s && Number.isInteger(s.minute)) { input.value = s.minute; mcState.scheduleMinute = s.minute; }
  } catch (e) {
    if (status) status.textContent = "读取定时配置失败";
  }
  if (status) status.textContent = "";
  saveBtn.onclick = async () => {
    const minute = Number(input.value);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      if (status) { status.textContent = "请输入 0-59 的整数分钟"; status.className = "mc-schedule-status error"; }
      return;
    }
    if (status) { status.textContent = "保存中…"; status.className = "mc-schedule-status"; }
    try {
      const res = await apiPut("/api/multi-country/schedule", { minute });
      if (res && res.ok) {
        if (status) { status.textContent = `✅ 已保存：每小时 ${res.minute} 分校验`; status.className = "mc-schedule-status ok"; }
      } else {
        const err = res && res.sync && res.sync.error ? res.sync.error : "保存失败";
        if (status) { status.textContent = `❌ ${err}`; status.className = "mc-schedule-status error"; }
      }
    } catch (e) {
      if (status) { status.textContent = `❌ ${e.message || String(e)}`; status.className = "mc-schedule-status error"; }
    }
  };
}

/** 渲染当前筛选 + 分页下的多国校验结果。 */
// 明细表分页状态（key: runId|countryCode）
const mcDetailPage = {};
const MC_DETAIL_PAGE_SIZE = 20;
const MC_DETAIL_MAX = 200;

/** 渲染单个国家的差异明细表（含明细分页，每页 20 条，最多 200 条）。 */
function renderMcDetailBlock(c) {
  const dets = (c.details || []).slice(0, MC_DETAIL_MAX);
  if (!dets.length) return "";
  const key = (c.runId || "") + "|" + (c.code || c.label || "");
  if (!(key in mcDetailPage)) mcDetailPage[key] = 1;
  const totalPages = Math.max(1, Math.ceil(dets.length / MC_DETAIL_PAGE_SIZE));
  if (mcDetailPage[key] > totalPages) mcDetailPage[key] = totalPages;
  const page = mcDetailPage[key];
  const start = (page - 1) * MC_DETAIL_PAGE_SIZE;
  const pageDets = dets.slice(start, start + MC_DETAIL_PAGE_SIZE);
  const rows = pageDets.map((d) => `<tr><td>${escapeHtml(d.check_item)}</td><td>${escapeHtml(d.asset_item_no)}</td><td>${escapeHtml(d.user_id)}</td><td>${d.src_value === null || d.src_value === undefined ? '<span class="mc-null">无</span>' : escapeHtml(d.src_value)}</td><td>${d.dest_value === null || d.dest_value === undefined ? '<span class="mc-null">无</span>' : escapeHtml(d.dest_value)}</td></tr>`).join("");
  const pagerHtml = totalPages > 1
    ? `<div class="mc-detail-pager">
        <button class="mc-page-btn mc-detail-page-btn" data-key="${escapeHtml(key)}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹ 上一页</button>
        <span class="mc-page-info">${page} / ${totalPages}（共 ${dets.length} 条）</span>
        <button class="mc-page-btn mc-detail-page-btn" data-key="${escapeHtml(key)}" data-page="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页 ›</button>
      </div>`
    : `<div class="mc-page-info">共 ${dets.length} 条</div>`;
  return `
    <div class="mc-detail-body" data-mc-detail-key="${escapeHtml(key)}">
      <div class="mc-sql-title">差异明细（最多展示 ${MC_DETAIL_MAX} 条）</div>
      <table class="mc-detail-table">
        <thead><tr><th>检查项</th><th>资产号</th><th>用户ID</th><th>源值</th><th>目标值</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${pagerHtml}
    </div>
  `;
}

function renderMcResults(root) {
  const el = root.querySelector("#mc-results");
  if (!el) return;
  if (!mcState.runs.length) {
    el.innerHTML = `<div class="mc-empty">
      <div class="mc-empty-icon">📊</div>
      <div class="mc-empty-title">暂无多国一致性校验记录</div>
      <div class="mc-empty-desc">「多国一致性校验告警」n8n 工作流会在每个整点的第 ${escapeHtml(mcState.scheduleMinute ?? 55)} 分自动执行，异常时会回写到这里。</div>
    </div>`;
    renderMcPager(root, 0);
    return;
  }
  // 筛选：只看异常 + 按国家
  const filtered = mcState.runs.filter((run) => {
    const abnormalCountries = (run.countries || []).filter((c) => (c.mismatches || []).length > 0);
    if (mcState.onlyAlert && abnormalCountries.length === 0) return false;
    if (mcState.country && !abnormalCountries.some((c) => (c.label || c.code || "") === mcState.country)) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / mcState.pageSize));
  if (mcState.page > totalPages) mcState.page = totalPages;
  const start = (mcState.page - 1) * mcState.pageSize;
  const pageRuns = filtered.slice(start, start + mcState.pageSize);
  el.innerHTML = pageRuns.map((run, idx) => {
    const ts = formatTs(run.checkedAt);
    // 只显示有异常的国家
    const abnormal = (run.countries || []).filter((c) => (c.mismatches || []).length > 0);
    const summary = abnormal.map((c) => {
      const m = c.mismatches || [];
      const detail = m.length
        ? ` (${m.map((x) => `${x.check_item}=${x.mismatch_cnt}`).join(", ")})`
        : "";
      return `<span class="mc-badge mc-badge-red">${escapeHtml(c.label || c.code || "")}${detail}</span>`;
    }).join(" ");
    const alertMark = run.hasAlert ? ` <span class="mc-badge mc-badge-red">异常</span>` : ` <span class="mc-badge mc-badge-green">正常</span>`;
    const detailPanels = abnormal.map((c) => {
      const m = c.mismatches || [];
      const sql = c.sql || c.detailSql || "";
      if (!m.length && !sql) return "";
      const summaryHtml = m.length
        ? `<div class="mc-summary">异常 ${m.length} 项：${m.map((x) => `${escapeHtml(x.check_item)}（${escapeHtml(x.mismatch_cnt)} 条）`).join("、")}</div>`
        : "";
      return `
        <details class="mc-detail">
          <summary>📄 ${escapeHtml(c.label || c.code || "")} · 校验语句与差异明细</summary>
          ${summaryHtml}
          ${sql ? `<div class="mc-sql-title">校验语句（${c.code || ""}）<button class="mc-copy-btn" data-copy-sql="${escapeHtml(sql)}" title="复制校验语句">📋 复制</button></div><pre class="mc-sql">${escapeHtml(sql)}</pre>` : ""}
          ${renderMcDetailBlock({ ...c, runId: run.id })}
        </details>
      `;
    }).join("");
    return `
      <div class="mc-run ${(start + idx) === 0 ? "mc-run-latest" : ""}">
        <div class="mc-run-head">
          <span class="mc-run-id">#${run.id ? String(run.id).slice(0, 8) : start + idx + 1}</span>
          <span class="mc-run-ts">${ts}</span>
          ${alertMark}
        </div>
        <div class="mc-run-countries">${summary || `<span class="mc-badge mc-badge-gray">无异常国家</span>`}</div>
        ${detailPanels}
      </div>
    `;
  }).join("");
  // 明细分页按钮
  el.querySelectorAll(".mc-detail-page-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const p = Number(btn.dataset.page);
      const tp = Math.max(1, Math.ceil(((mcState.runs.find((r) => r.id === key.split("|")[0])?.countries || []).find((c) => (c.code || c.label || "") === key.split("|")[1])?.details || []).length / MC_DETAIL_PAGE_SIZE));
      if (key && p >= 1 && p <= tp) {
        mcDetailPage[key] = p;
        // 找到对应国家详情面板，局部重渲染
        const runId = key.split("|")[0];
        const code = key.split("|")[1];
        const run = mcState.runs.find((r) => String(r.id).slice(0, 8) === String(runId).slice(0, 8) || r.id === runId);
        const detailsEl = el.querySelector(`[data-mc-detail-key="${CSS.escape(key)}"]`);
        if (detailsEl) {
          detailsEl.innerHTML = renderMcDetailBlock({ ...(run?.countries || []).find((c) => (c.code || c.label || "") === code), runId });
        }
      }
    });
  });
  // 复制校验语句按钮（事件委托，覆盖局部重渲染）
  el.querySelectorAll(".mc-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sql = btn.dataset.copySql || "";
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(sql);
        btn.textContent = "✅ 已复制";
        btn.classList.add("copied");
      } catch (e) {
        // clipboard 不可用时 fallback
        const ta = document.createElement("textarea");
        ta.value = sql;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); btn.textContent = "✅ 已复制"; btn.classList.add("copied"); }
        catch (e2) { btn.textContent = "❌ 复制失败"; }
        document.body.removeChild(ta);
      }
      setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1500);
    });
  });
  renderMcPager(root, totalPages);
  renderMcEmpty(filtered.length);
}

/** 渲染分页控件。 */
function renderMcPager(root, totalPages) {
  const pager = root.querySelector("#mc-pager");
  if (!pager) return;
  if (totalPages <= 1) { pager.innerHTML = ""; return; }
  pager.innerHTML = `
    <button class="mc-page-btn" data-page="${mcState.page - 1}" ${mcState.page <= 1 ? "disabled" : ""}>‹ 上一页</button>
    <span class="mc-page-info">${mcState.page} / ${totalPages}</span>
    <button class="mc-page-btn" data-page="${mcState.page + 1}" ${mcState.page >= totalPages ? "disabled" : ""}>下一页 ›</button>
  `;
  pager.querySelectorAll(".mc-page-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = Number(btn.dataset.page);
      if (p >= 1 && p <= totalPages) {
        mcState.page = p;
        renderMcResults(root);
      }
    });
  });
}

function renderMcEmpty(filteredCount) {
  const el = document.querySelector("#mc-results");
  if (el && filteredCount === 0 && mcState.runs.length) {
    el.innerHTML = `<div class="mc-empty">
      <div class="mc-empty-icon">🔍</div>
      <div class="mc-empty-title">没有符合当前筛选条件的记录</div>
      <div class="mc-empty-desc">试试清除「只看异常」或更换国家筛选。</div>
    </div>`;
  }
}

function formatTs(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadList(root) {
  const listEl = root.querySelector("#ar-list");
  listEl.innerHTML = `<div class="notice">正在加载…</div>`;
  let alerts;
  try {
    alerts = await apiGet("/api/alert-registry");
  } catch (error) {
    listEl.innerHTML = `<div class="sandbox-status error"><strong>加载失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    return;
  }
  const items = Array.isArray(alerts) ? alerts : alerts?.alerts || [];
  if (!items.length) {
    listEl.innerHTML = `<div class="notice">暂无告警条目，点右上角「+ 新增告警」创建。</div>`;
    return;
  }
  listEl.innerHTML = `
    <div class="ar-table-wrap">
      <table class="ar-table">
        <thead>
          <tr>
            <th>名称 / ID</th>
            <th>国家</th>
            <th>来源</th>
            <th>触发</th>
            <th>状态</th>
            <th>执行命令</th>
            <th class="ar-ops-col">操作</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(renderRow).join("")}
        </tbody>
      </table>
    </div>
  `;
  listEl.querySelectorAll("[data-ar-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.arEdit;
      openEditor(root, items.find((item) => item.id === id) || null);
    });
  });
  listEl.querySelectorAll("[data-ar-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.arDelete;
      const item = items.find((item) => item.id === id);
      if (!confirm(`确认删除告警「${item.name}」？`)) return;
      try {
        await apiDelete(`/api/alert-registry/${encodeURIComponent(id)}`);
        loadList(root);
      } catch (error) {
        alert(`删除失败：${error.message}`);
      }
    });
  });
  listEl.querySelectorAll("[data-ar-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.arToggle;
      const item = items.find((item) => item.id === id);
      try {
        await apiPut(`/api/alert-registry/${encodeURIComponent(id)}`, { enabled: !item.enabled });
        loadList(root);
      } catch (error) {
        alert(`启停失败：${error.message}`);
      }
    });
  });
  listEl.querySelectorAll("[data-ar-test]").forEach((button) => {
    button.addEventListener("click", () => runTest(root, button.dataset.arTest));
  });
}

function renderRow(item) {
  const cmd = item.command || "";
  const srcLabel = {
    n8n: "n8n",
    nightingale: "夜莺",
    custom: "自定义",
  }[item.sourceType] || item.sourceType || "custom";
  const triggerLabel = {
    webhook: "Webhook",
    schedule: "定时",
    manual: "手动",
  }[item.trigger] || item.trigger || "手动";
  const srcClass = item.sourceType === "nightingale" ? "ar-badge-purple" : item.sourceType === "custom" ? "ar-badge-gray" : "ar-badge-blue";
  return `
    <tr>
      <td class="ar-name-cell">
        <div class="ar-name" title="${escapeHtml(item.note || "")}">${escapeHtml(item.name)}</div>
        <div class="ar-id" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</div>
      </td>
      <td><span class="ar-country">${escapeHtml(item.country || "-")}</span></td>
      <td><span class="badge ${srcClass}">${escapeHtml(srcLabel)}</span></td>
      <td><span class="ar-trigger">${escapeHtml(triggerLabel)}</span></td>
      <td><span class="badge ${item.enabled ? "ok" : ""} ar-status">${item.enabled ? "启用" : "停用"}</span></td>
      <td class="ar-cmd-cell">
        <code class="ar-cmd" title="${escapeHtml(cmd)}">${escapeHtml(cmd || "-")}</code>
      </td>
      <td class="ar-ops-col">
        <div class="ar-ops">
          <button class="ar-btn ar-btn-test" data-ar-test="${escapeHtml(item.id)}">▶ 测试</button>
          <button class="ar-btn" data-ar-edit="${escapeHtml(item.id)}">编辑</button>
          <button class="ar-btn" data-ar-toggle="${escapeHtml(item.id)}">${item.enabled ? "停用" : "启用"}</button>
          <button class="ar-btn ar-btn-danger" data-ar-delete="${escapeHtml(item.id)}">删除</button>
        </div>
      </td>
    </tr>
  `;
}

async function runTest(root, id) {
  const panel = root.querySelector("#ar-test-panel");
  const output = root.querySelector("#ar-test-output");
  panel.style.display = "";
  output.innerHTML = `<div class="notice">正在执行测试（SSH dry-run / 本地命令），最长 90 秒…</div>`;
  try {
    const result = await apiPost(`/api/alert-registry/${encodeURIComponent(id)}/test`, {}, { timeoutMs: 100000 });
    renderTestResult(output, result);
  } catch (error) {
    output.innerHTML = `<div class="sandbox-status error"><strong>测试失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
  }
}

function renderTestResult(output, result) {
  const ok = result.ok;
  const color = ok ? "success" : "error";
  output.innerHTML = `
    <div class="sandbox-status ${color}">
      <strong>${ok ? "测试通过" : "测试失败"} · 退出码 ${result.exitCode == null ? "-" : escapeHtml(String(result.exitCode))}</strong>
      <span>${escapeHtml(result.name || "")}</span>
    </div>
    ${renderOutputBlock("stdout", result.stdout)}
    ${result.stderr ? renderOutputBlock("stderr", result.stderr) : ""}
  `;
}

function renderOutputBlock(label, text) {
  if (!text) return "";
  return `
    <div class="panel-title">${escapeHtml(label)}</div>
    <pre class="code">${escapeHtml(text)}</pre>
  `;
}

// SQL 块 → 中文标签（模板占位符键名保持英文，标签用中文）
const SQL_BLOCK_LABELS = {
  BIZ_CTE_CLAUSE: "非经营 CTE 公共表（biz库）",
  FIN_UNION_SELECT: "财务对账查询（capital 三表）",
  BIZ_UNION_SELECT: "biz 对账查询（五国非经营）",
  BIZ_QUERY_SQL: "biz 对账查询（含 CTE，五国非经营）",
  MONITOR_TABLE: "监控表（被校验表）",
  LTV_QUERY_SQL: "LTV 查询语句",
  CHECK_TABLE: "校验记录表",
  EXPECTED_TABLES: "期望表清单（印尼）",
  MX_EXPECTED_TABLES: "期望表清单（墨西哥）",
};

function sqlBlockLabel(key) {
  return SQL_BLOCK_LABELS[key] || key;
}

function renderSqlEditorSection(data) {
  const blocks = (data.sqlBlocks && typeof data.sqlBlocks === "object") ? data.sqlBlocks : {};
  const blockNames = Object.keys(blocks).length
    ? Object.keys(blocks)
    : ["FIN_UNION_SELECT", "BIZ_CTE_CLAUSE", "BIZ_UNION_SELECT"];
  const blockHtml = blockNames.map((key) => {
    const value = blocks[key] || "";
    const lines = value ? value.split("\n").length : 0;
    return `
    <div class="ar-field-full">
      <div class="ar-sql-title">
        <span class="strong">${escapeHtml(sqlBlockLabel(key))}</span>
        <span class="muted">（${escapeHtml(key)}）</span>
        <span class="ar-sql-lines">${lines ? lines + " 行" : "空"}</span>
      </div>
      <textarea class="ar-field ar-sql-block" data-sql-block="${escapeHtml(key)}" data-auto-resize rows="4" placeholder="（在此填写 ${escapeHtml(sqlBlockLabel(key))} 的 SQL）">${escapeHtml(value)}</textarea>
    </div>
  `;
  }).join("");
  return `
    <div class="ar-section">
      <div class="ar-section-head">
        <span class="ar-sec-icon">🧩</span>
        <span>校验语句（SQL 块）</span>
        <span class="ar-sec-tip">保存后可「更新代码」合成脚本并部署/提交</span>
      </div>
      <div class="ar-section-body">
        <div class="ar-field-grid">
          <label class="ar-label">模板名
            <input class="ar-field" id="ar-f-template" value="${escapeHtml(data.templateName || "")}" placeholder="如 fin_ods_quality / mx_capital_ltv / id_marketing_dwd_cnt">
          </label>
          <label class="ar-label">仓库内脚本路径
            <input class="ar-field" id="ar-f-scriptPath" value="${escapeHtml(data.scriptPath || "")}" placeholder="如 alert/fin_manage_ods_data_quality_monitor_alert.py">
          </label>
          <label class="ar-label">目标机脚本路径
            <input class="ar-field" id="ar-f-remotePath" value="${escapeHtml(data.remoteScriptPath || "")}" placeholder="如 /root/starrocks-pl-monitor-tv-alert/alert/xxx.py">
          </label>
          <label class="ar-label">本地 Git 仓库目录
            <input class="ar-field" id="ar-f-repoDir" value="${escapeHtml(data.repoDir || "")}" placeholder="如 /path/to/starrocks-pl-monitor-tv-alert 或 \${ALERT_REPO_DIR}">
          </label>
          ${blockHtml}
        </div>
        <div class="ar-note-line" style="margin-top:12px">SQL 块内容会注入模板对应占位符；「预览脚本」可先看合成结果，确认无误后点「更新代码」写入仓库、git 提交推送并 SSH 部署到目标机。</div>
      </div>
    </div>
  `;
}

function openEditor(root, item) {
  const isEdit = Boolean(item);
  const data = item || {};
  const fields = [
    ["id", "ID（留空自动生成）", data.id || "", "ar-f-id"],
    ["name", "名称 *", data.name || "", "ar-f-name"],
    ["country", "国家", data.country || "", "ar-f-country"],
    ["sourceType", "来源类型", data.sourceType || "n8n", "ar-f-sourceType"],
    ["n8nWorkflowId", "n8n 工作流 ID", data.n8nWorkflowId || "", "ar-f-workflow"],
    ["trigger", "触发方式", data.trigger || "manual", "ar-f-trigger"],
    ["webhookPath", "Webhook 路径", data.webhookPath || "", "ar-f-webhook"],
    ["command", "执行命令 *（测试代码 / dry-run）", data.command || "", "ar-f-command"],
    ["runVia", "执行方式", data.runVia || "ssh", "ar-f-runVia"],
    ["sshHost", "SSH 主机", data.sshHost || "root@10.20.47.14", "ar-f-host"],
    ["sshPort", "SSH 端口", data.sshPort != null ? String(data.sshPort) : "36000", "ar-f-port"],
    ["mentions", "@ 成员（逗号分隔）", data.mentions || "", "ar-f-mentions"],
    ["enabled", "启用", data.enabled !== false, "ar-f-enabled"],
    ["note", "备注", data.note || "", "ar-f-note"],
  ];
  const sourceOptions = ["n8n", "nightingale", "custom"].map((v) =>
    `<option value="${v}" ${data.sourceType === v || (!data.sourceType && v === "n8n") ? "selected" : ""}>${v}</option>`
  ).join("");
  const triggerOptions = ["webhook", "schedule", "manual"].map((v) =>
    `<option value="${v}" ${data.trigger === v || (!data.trigger && v === "manual") ? "selected" : ""}>${v}</option>`
  ).join("");
  const runViaOptions = ["ssh", "local"].map((v) =>
    `<option value="${v}" ${data.runVia === v || (!data.runVia && v === "ssh") ? "selected" : ""}>${v}</option>`
  ).join("");

  const overlay = document.createElement("div");
  overlay.className = "ar-modal-overlay";
  overlay.innerHTML = `
    <div class="ar-modal">
      <div class="ar-modal-header">
        <div>
          <h2 class="page-title">${isEdit ? "编辑告警" : "新增告警"}</h2>
          <p class="page-note">配置条目信息；「测试命令」可先验证任意命令（新增前的测试代码），通过后再保存。</p>
        </div>
        <button id="ar-modal-close" class="ar-modal-close" title="关闭">×</button>
      </div>
      <div class="ar-modal-body">

        <div class="ar-section">
          <div class="ar-section-head">
            <span class="ar-sec-icon">📋</span>
            <span>基本信息</span>
          </div>
          <div class="ar-section-body">
            <div class="ar-field-grid">
              <label class="ar-label">ID
                <input class="ar-field" id="ar-f-id" value="${escapeHtml(fields[0][2])}" ${isEdit ? "readonly" : ""} placeholder="留空自动生成">
              </label>
              <label class="ar-label">名称 <span class="ar-req">*</span>
                <input class="ar-field" id="ar-f-name" value="${escapeHtml(fields[1][2])}">
              </label>
              <label class="ar-label">国家
                <input class="ar-field" id="ar-f-country" value="${escapeHtml(fields[2][2])}" placeholder="CN / MX / ID / PH…">
              </label>
              <label class="ar-label">来源类型
                <select class="ar-field" id="ar-f-sourceType">${sourceOptions}</select>
              </label>
              <label class="ar-label">n8n 工作流 ID
                <input class="ar-field" id="ar-f-workflow" value="${escapeHtml(fields[4][2])}">
              </label>
              <label class="ar-label">触发方式
                <select class="ar-field" id="ar-f-trigger">${triggerOptions}</select>
              </label>
              <label class="ar-label">Webhook 路径
                <input class="ar-field" id="ar-f-webhook" value="${escapeHtml(fields[6][2])}">
              </label>
              <label class="ar-label ar-field-wrap-check"><input type="checkbox" id="ar-f-enabled" ${fields[12][2] ? "checked" : ""}> 启用 <span class="ar-hint">是否参与触发</span></label>
            </div>
          </div>
        </div>

        <div class="ar-section">
          <div class="ar-section-head">
            <span class="ar-sec-icon">🚀</span>
            <span>执行与测试</span>
            <span class="ar-sec-tip">测试代码 / dry-run，支持 \${ENV} 占位</span>
          </div>
          <div class="ar-section-body">
            <div class="ar-field-grid">
              <label class="ar-label">执行方式
                <select class="ar-field" id="ar-f-runVia">${runViaOptions}</select>
              </label>
              <label class="ar-label">SSH 端口
                <input class="ar-field" id="ar-f-port" value="${escapeHtml(fields[10][2])}">
              </label>
              <label class="ar-label ar-field-full">SSH 主机
                <input class="ar-field" id="ar-f-host" value="${escapeHtml(fields[9][2])}" placeholder="如 root@10.20.47.14">
              </label>
              <label class="ar-label ar-field-full">@ 成员（逗号分隔）
                <input class="ar-field" id="ar-f-mentions" value="${escapeHtml(fields[11][2])}">
              </label>
              <label class="ar-label ar-field-full">执行命令 <span class="ar-req">*</span>
                <textarea class="ar-field ar-cmd-area" id="ar-f-command" data-auto-resize rows="4">${escapeHtml(fields[7][2])}</textarea>
              </label>
              <label class="ar-label ar-field-full">备注
                <input class="ar-field" id="ar-f-note" value="${escapeHtml(fields[13][2])}">
              </label>
            </div>
          </div>
        </div>

        ${renderSqlEditorSection(data)}
      </div>
      <div class="ar-modal-footer">
        <span class="ar-modal-progress muted small"></span>
        <button class="ar-btn ar-btn-test" id="ar-test-command">▶ 先测试命令</button>
        ${isEdit ? `<button class="ar-btn ar-btn-code" id="ar-preview-script">👁 预览脚本</button>
        <button class="ar-btn ar-btn-code" id="ar-apply-script">⚡ 更新代码（部署+提交）</button>` : ""}
        <button class="ar-btn ar-btn-primary" id="ar-save">${isEdit ? "保存" : "新增"}</button>
      </div>
      <div id="ar-command-output" style="padding:0 24px"></div>
      <div id="ar-script-output" style="padding:0 24px 12px"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // SQL 块 / 命令文本域自动适配高度（内容多则增高，最多 14 行后内部滚动）
  const autoResize = (el) => {
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 19;
    const minRows = 3;
    const maxRows = 14;
    el.style.height = "auto";
    const contentLines = Math.ceil(el.scrollHeight / lineHeight);
    const rows = Math.max(minRows, Math.min(maxRows, contentLines));
    el.style.height = `${Math.ceil(rows * lineHeight)}px`;
  };
  overlay.querySelectorAll("[data-auto-resize]").forEach((el) => {
    autoResize(el);
    el.addEventListener("input", () => autoResize(el));
  });

  const close = () => overlay.remove();
  overlay.querySelector("#ar-modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  overlay.querySelector("#ar-test-command").addEventListener("click", async () => {
    const cmd = overlay.querySelector("#ar-f-command").value;
    if (!cmd) {
      overlay.querySelector("#ar-command-output").innerHTML = `<div class="sandbox-status error"><strong>请先填写命令</strong></div>`;
      return;
    }
    const output = overlay.querySelector("#ar-command-output");
    output.innerHTML = `<div class="notice">正在执行命令，最长 90 秒…</div>`;
    try {
      const result = await apiPost("/api/alert-registry/test-command", {
        runVia: overlay.querySelector("#ar-f-runVia").value,
        command: cmd,
        sshHost: overlay.querySelector("#ar-f-host").value,
        sshPort: Number(overlay.querySelector("#ar-f-port").value || 36000),
      }, { timeoutMs: 100000 });
      output.innerHTML = renderCommandResult(result);
    } catch (error) {
      output.innerHTML = `<div class="sandbox-status error"><strong>命令执行失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
    }
  });

  const previewBtn = overlay.querySelector("#ar-preview-script");
  if (previewBtn) {
    previewBtn.addEventListener("click", async () => {
      const output = overlay.querySelector("#ar-script-output");
      const entry = { ...collectEditorEntry(overlay, item) };
      output.innerHTML = `<div class="notice">正在渲染脚本…</div>`;
      try {
        // 预览需要先把当前编辑内容存到条目（PUT），再调 preview-script
        await apiPut(`/api/alert-registry/${encodeURIComponent(item.id)}`, entry);
        const result = await apiPost(`/api/alert-registry/${encodeURIComponent(item.id)}/preview-script`, {});
        renderScriptPreview(output, result);
      } catch (error) {
        output.innerHTML = `<div class="sandbox-status error"><strong>预览失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
      }
    });
  }

  const applyBtn = overlay.querySelector("#ar-apply-script");
  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      const output = overlay.querySelector("#ar-script-output");
      const entry = collectEditorEntry(overlay, item);
      if (!confirm("确认更新代码？将：①渲染脚本 ②写入仓库文件 ③git commit+push ④SSH 部署到目标机。")) return;
      output.innerHTML = `<div class="notice">正在更新代码（写仓库 + 提交 + 部署）…</div>`;
      try {
        await apiPut(`/api/alert-registry/${encodeURIComponent(item.id)}`, entry);
        const result = await apiPost(`/api/alert-registry/${encodeURIComponent(item.id)}/apply-script`, {});
        renderScriptApply(output, result);
      } catch (error) {
        output.innerHTML = `<div class="sandbox-status error"><strong>更新失败</strong><span>${escapeHtml(error.message || String(error))}</span></div>`;
      }
    });
  }

  overlay.querySelector("#ar-save").addEventListener("click", async () => {
    const name = overlay.querySelector("#ar-f-name").value.trim();
    const command = overlay.querySelector("#ar-f-command").value.trim();
    if (!name || !command) {
      alert("名称与执行命令为必填项");
      return;
    }
    const body = {
      id: overlay.querySelector("#ar-f-id").value.trim() || undefined,
      name,
      country: overlay.querySelector("#ar-f-country").value.trim(),
      sourceType: overlay.querySelector("#ar-f-sourceType").value,
      n8nWorkflowId: overlay.querySelector("#ar-f-workflow").value.trim(),
      trigger: overlay.querySelector("#ar-f-trigger").value,
      webhookPath: overlay.querySelector("#ar-f-webhook").value.trim(),
      command,
      runVia: overlay.querySelector("#ar-f-runVia").value,
      sshHost: overlay.querySelector("#ar-f-host").value.trim(),
      sshPort: Number(overlay.querySelector("#ar-f-port").value || 36000),
      mentions: overlay.querySelector("#ar-f-mentions").value.trim(),
      enabled: overlay.querySelector("#ar-f-enabled").checked,
      note: overlay.querySelector("#ar-f-note").value.trim(),
      templateName: overlay.querySelector("#ar-f-template")?.value.trim() || "",
      scriptPath: overlay.querySelector("#ar-f-scriptPath")?.value.trim() || "",
      remoteScriptPath: overlay.querySelector("#ar-f-remotePath")?.value.trim() || "",
      repoDir: overlay.querySelector("#ar-f-repoDir")?.value.trim() || "",
      sqlBlocks: collectSqlBlocks(overlay),
    };
    try {
      if (isEdit) {
        await apiPut(`/api/alert-registry/${encodeURIComponent(item.id)}`, body);
      } else {
        await apiPost("/api/alert-registry", body);
      }
      close();
      loadList(root);
    } catch (error) {
      alert(`保存失败：${error.message}`);
    }
  });
}

function renderCommandResult(result) {
  const ok = result.ok;
  const color = ok ? "success" : "error";
  return `
    <div class="sandbox-status ${color}">
      <strong>${ok ? "命令通过" : "命令失败"} · 退出码 ${result.exitCode == null ? "-" : escapeHtml(String(result.exitCode))}</strong>
    </div>
    ${result.stdout ? `<pre class="code">${escapeHtml(result.stdout)}</pre>` : ""}
    ${result.stderr ? `<pre class="code">${escapeHtml(result.stderr)}</pre>` : ""}
  `;
}

function collectSqlBlocks(overlay) {
  const blocks = {};
  overlay.querySelectorAll(".ar-sql-block").forEach((textarea) => {
    const key = textarea.dataset.sqlBlock;
    const value = textarea.value;
    if (key && value.trim()) blocks[key] = value;
  });
  return blocks;
}

function collectEditorEntry(overlay, item) {
  return {
    id: overlay.querySelector("#ar-f-id").value.trim() || undefined,
    name: overlay.querySelector("#ar-f-name").value.trim(),
    country: overlay.querySelector("#ar-f-country").value.trim(),
    sourceType: overlay.querySelector("#ar-f-sourceType").value,
    n8nWorkflowId: overlay.querySelector("#ar-f-workflow").value.trim(),
    trigger: overlay.querySelector("#ar-f-trigger").value,
    webhookPath: overlay.querySelector("#ar-f-webhook").value.trim(),
    command: overlay.querySelector("#ar-f-command").value.trim(),
    runVia: overlay.querySelector("#ar-f-runVia").value,
    sshHost: overlay.querySelector("#ar-f-host").value.trim(),
    sshPort: Number(overlay.querySelector("#ar-f-port").value || 36000),
    mentions: overlay.querySelector("#ar-f-mentions").value.trim(),
    enabled: overlay.querySelector("#ar-f-enabled").checked,
    note: overlay.querySelector("#ar-f-note").value.trim(),
    templateName: overlay.querySelector("#ar-f-template")?.value.trim() || "",
    scriptPath: overlay.querySelector("#ar-f-scriptPath")?.value.trim() || "",
    remoteScriptPath: overlay.querySelector("#ar-f-remotePath")?.value.trim() || "",
    repoDir: overlay.querySelector("#ar-f-repoDir")?.value.trim() || "",
    sqlBlocks: collectSqlBlocks(overlay),
  };
}

function renderScriptPreview(output, result) {
  if (!result.ok) {
    output.innerHTML = `
      <div class="sandbox-status error"><strong>脚本渲染不完整</strong><span>${escapeHtml(result.note || "")}${result.missing ? "：" + escapeHtml(result.missing.join(", ")) : ""}</span></div>
    `;
    return;
  }
  const diff = result.diff || {};
  output.innerHTML = `
    <div class="sandbox-status success">
      <strong>脚本渲染成功</strong>
      <span>${escapeHtml(result.note || "")} · 变更 ${diff.added ?? "-"} 增 / ${diff.removed ?? "-"} 删（${diff.newLines ?? result.length} 行）</span>
    </div>
    <details>
      <summary>查看渲染后的完整脚本（${escapeHtml(String(result.length || 0))} 字符）</summary>
      <pre class="code">${escapeHtml(result.rendered || "")}</pre>
    </details>
  `;
}

function renderScriptApply(output, result) {
  const git = result.git || {};
  const deploy = result.deploy || {};
  const parts = [];
  if (result.repoFile) parts.push(`仓库文件：<code>${escapeHtml(result.repoFile)}</code>`);
  if (result.git) parts.push(`Git：<span class="${git.ok ? "" : "muted"}">${git.ok ? "提交并推送成功" : "推送失败"}</span> ${git.stderr ? `<pre class="code">${escapeHtml(git.stderr)}</pre>` : ""}`);
  if (result.deploy) parts.push(`目标机部署：<span class="${deploy.ok ? "" : "muted"}">${deploy.ok ? "成功" : "失败"}</span> ${deploy.stderr ? `<pre class="code">${escapeHtml(deploy.stderr)}</pre>` : ""}`);
  if (!result.repoFile && !result.git && !result.deploy) {
    parts.push("未配置 repoDir/scriptPath 或 remoteScriptPath，仅完成渲染。");
  }
  output.innerHTML = `
    <div class="sandbox-status ${result.ok ? "success" : "error"}">
      <strong>${result.ok ? "更新代码完成" : "更新失败"}</strong><span>${escapeHtml(String(result.length || ""))} 字符</span>
    </div>
    <div class="muted">${parts.join("<br>")}</div>
  `;
}

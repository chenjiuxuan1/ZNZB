import { apiGet, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";

const LAYERS = ["ods", "dwd", "dws", "ads"];

const COUNTRY_NAMES = {
  cn: "中国",
  ine: "印尼",
  mx: "墨西哥",
  ph: "菲律宾",
  pk: "巴基斯坦",
  th: "泰国",
};

export function renderDataGovernance(root) {
  const data = state.dataGovernance || (state.dataGovernance = {});
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">数据治理</h1>
        <p class="page-note">多国数仓僵尸表(零访问)扫描 · 四层(ods/dwd/dws/ads)备份表识别 · 导出 CSV/Excel · DROP SQL 草稿。DROP 仅生成草稿文件，永不自动执行。</p>
      </div>
      ${renderHealth(data.health)}
    </div>

    <section class="panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">扫描配置</h2>
          <p class="muted">选择国家与扫描类型，触发后端 n8n 工作流扫描。</p>
        </div>
      </div>
      <div class="form-grid">
        <label>国家
          <select id="gov-country">
            ${Object.entries(COUNTRY_NAMES).map(([code, name]) => `
              <option value="${code}" ${(data.country || "pk") === code ? "selected" : ""}>${name} (${code})</option>
            `).join("")}
          </select>
        </label>
        <label>扫描类型
          <select id="gov-type">
            <option value="zombie" ${(data.type || "zombie") === "zombie" ? "selected" : ""}>零访问(僵尸)表</option>
            <option value="bak" ${data.type === "bak" ? "selected" : ""}>备份表</option>
          </select>
        </label>
        <label>回看天数
          <input id="gov-lookback" type="number" min="1" max="90" value="${data.lookback || 30}" />
        </label>
        <label>限定层
          <select id="gov-layers" multiple size="4">
            ${LAYERS.map((l) => `
              <option value="${l}" ${(!data.layers || data.layers.includes(l)) ? "selected" : ""}>${l}</option>
            `).join("")}
          </select>
          <small class="muted">Ctrl/⌘ 多选；全选 = 四层</small>
        </label>
      </div>
      <div class="button-row">
        <button id="gov-scan" class="primary">触发扫描</button>
        <button id="gov-query" class="secondary">查询结果</button>
        <button id="gov-bucket" class="secondary">分桶合理性检测</button>
        <button id="gov-export" class="secondary">导出 Excel</button>
        <button id="gov-export-csv" class="secondary">导出 CSV</button>
        <button id="gov-drop" class="danger-ghost">生成 DROP 草稿</button>
      </div>
      <div id="gov-status"></div>
    </section>

    <section class="panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">结果</h2>
          <p class="muted" id="gov-result-meta">${escapeHtml(data.resultMeta || "等待查询结果")}</p>
        </div>
      </div>
      <div id="gov-result">${renderResultTable(data.rows, data.resultMeta)}</div>
    </section>
  `;

  root.querySelector("#gov-scan")?.addEventListener("click", () => void runScan(root));
  root.querySelector("#gov-query")?.addEventListener("click", () => void runQuery(root));
  root.querySelector("#gov-bucket")?.addEventListener("click", () => void runBucketCheck(root));
  root.querySelector("#gov-export")?.addEventListener("click", () => void runExport(root, "xlsx"));
  root.querySelector("#gov-export-csv")?.addEventListener("click", () => void runExport(root, "csv"));
  root.querySelector("#gov-drop")?.addEventListener("click", () => void runDrop(root));
  if (!data.health) void loadHealth(root);
}

function readControls(root) {
  const country = root.querySelector("#gov-country")?.value || "pk";
  const type = root.querySelector("#gov-type")?.value || "zombie";
  const lookback = Number(root.querySelector("#gov-lookback")?.value || 30);
  const selectedLayers = Array.from(root.querySelectorAll("#gov-layers option"))
    .filter((o) => o.selected)
    .map((o) => o.value);
  const data = state.dataGovernance || (state.dataGovernance = {});
  Object.assign(data, { country, type, lookback, layers: selectedLayers });
  return { country, type, lookback, layers: selectedLayers };
}

function setStatus(root, html, kind = "info") {
  const el = root.querySelector("#gov-status");
  if (!el) return;
  el.innerHTML = `<div class="status-line status-${kind}">${html}</div>`;
}

async function loadHealth(root) {
  try {
    const health = await apiGet("/api/data-governance/health");
    const data = state.dataGovernance || (state.dataGovernance = {});
    data.health = health;
    const el = root.querySelector("[data-gov-health]");
    if (el) {
      el.innerHTML = health.toolsExist
        ? `<span class="ok">✓ Pi 包就绪</span>`
        : `<span class="bad">✗ Pi 包缺失</span>`;
    }
  } catch (error) {
    const el = root.querySelector("[data-gov-health]");
    if (el) el.innerHTML = `<span class="bad">✗ 后端不可用: ${escapeHtml(error.message)}</span>`;
  }
}

async function runScan(root) {
  const controls = readControls(root);
  setStatus(root, "正在触发扫描…（后端 n8n 异步执行，印尼/巴基斯坦可能需 2-4 分钟）");
  try {
    const result = await apiPost("/api/data-governance/scan", {
      country: controls.country,
      type: controls.type,
      layers: controls.layers,
      lookback_days: controls.lookback,
      bak: controls.type === "bak",
    }, { timeoutMs: 30000 });
    const data = state.dataGovernance || (state.dataGovernance = {});
    data.bucketMode = false;
    setStatus(root, `✓ 扫描已受理（${escapeHtml(COUNTRY_NAMES[controls.country])} / ${controls.type === "bak" ? "备份表" : "零访问"} / 层: ${controls.layers.join(",") || "全库"}）。稍候点击「查询结果」读取。<small>${escapeHtml(result.instruction || "")}</small>`);
  } catch (error) {
    setStatus(root, `✗ ${escapeHtml(error.message)}`, "error");
  }
}

async function runQuery(root) {
  const controls = readControls(root);
  setStatus(root, "正在查询…");
  try {
    const result = await apiPost("/api/data-governance/query", {
      country: controls.country,
      layers: controls.layers,
      bak: controls.type === "bak",
    }, { timeoutMs: 60000 });
    const data = state.dataGovernance || (state.dataGovernance = {});
    data.rows = result.rows || [];
    data.bucketMode = false;
    data.resultMeta = `国家 ${COUNTRY_NAMES[controls.country]} · 共 ${data.rows.length} 张 · ${String(result.note || "")}`;
    renderDataGovernance(root);
    setStatus(root, `✓ 查询完成：${data.rows.length} 张表`);
  } catch (error) {
    setStatus(root, `✗ ${escapeHtml(error.message)}`, "error");
  }
}

async function runBucketCheck(root) {
  const controls = readControls(root);
  setStatus(root, "正在检测分桶合理性…（HASH 分桶≤10 且每桶行数≥1000万）");
  try {
    const result = await apiPost("/api/data-governance/bucket-check", {
      country: controls.country,
    }, { timeoutMs: 90000 });
    const data = state.dataGovernance || (state.dataGovernance = {});
    data.rows = result.rows || [];
    data.resultMeta = `分桶合理性检测 · ${escapeHtml(COUNTRY_NAMES[controls.country])} · 发现 ${data.rows.length} 张分桶不合理的表`;
    data.bucketMode = true;
    renderDataGovernance(root);
    setStatus(root, `✓ 分桶检测完成：${data.rows.length} 张表分桶不合理`);
  } catch (error) {
    setStatus(root, `✗ ${escapeHtml(error.message)}`, "error");
  }
}

async function runExport(root, format) {
  const controls = readControls(root);
  const data = state.dataGovernance || (state.dataGovernance = {});
  if (!data.rows || !data.rows.length) {
    setStatus(root, "请先「查询结果」再导出。", "error");
    return;
  }
  const isBucket = !!data.bucketMode;
  const rows = isBucket
    ? data.rows.map((r) => ({
        table_schema: r.TABLE_SCHEMA,
        table_name: r.TABLE_NAME,
        table_model: r.TABLE_MODEL,
        partition_key: r.PARTITION_KEY,
        distribute_key: r.DISTRIBUTE_KEY,
        distribute_bucket: r.DISTRIBUTE_BUCKET,
        table_rows: r.TABLE_ROWS,
        size_gb: Number(r.DATA_SIZE_GB || 0),
        rows_per_bucket: r.ROWS_PER_BUCKET,
      }))
    : data.rows;
  setStatus(root, `正在导出 ${format.toUpperCase()}…`);
  try {
    const result = await apiPost("/api/data-governance/export", {
      rows,
      format,
      country: controls.country,
      name: isBucket ? "分桶不合理表" : controls.type === "bak" ? "备份表" : "零访问表",
    }, { timeoutMs: 60000 });
    setStatus(root, `✓ 已导出: ${escapeHtml(result.file)}（${result.rowCount} 行）`);
  } catch (error) {
    setStatus(root, `✗ ${escapeHtml(error.message)}`, "error");
  }
}

async function runDrop(root) {
  const controls = readControls(root);
  const data = state.dataGovernance || (state.dataGovernance = {});
  if (data.bucketMode) {
    setStatus(root, "分桶检测结果请用「导出」保存清单；分桶调整是 ALTER 操作，不在 DROP 草稿范围。", "error");
    return;
  }
  if (!data.rows || !data.rows.length) {
    setStatus(root, "请先「查询结果」再生成 DROP 草稿。", "error");
    return;
  }
  if (!window.confirm(`为 ${escapeHtml(COUNTRY_NAMES[controls.country])} 的 ${data.rows.length} 张表生成 DROP 草稿？仅写文件，不执行。`)) return;
  setStatus(root, "正在生成 DROP 草稿…");
  try {
    const result = await apiPost("/api/data-governance/drop", {
      rows: data.rows,
      country: controls.country,
    }, { timeoutMs: 60000 });
    setStatus(root, `✓ DROP 草稿已生成: ${escapeHtml(result.file)}（未执行）`);
  } catch (error) {
    setStatus(root, `✗ ${escapeHtml(error.message)}`, "error");
  }
}

function renderResultTable(rows = [], meta = "") {
  if (!rows || !rows.length) {
    return `<div class="empty-hint">暂无结果。请先触发扫描，再点击「查询结果」，或点击「分桶合理性检测」。</div>`;
  }
  const isBucket = !!(state.dataGovernance && state.dataGovernance.bucketMode);
  if (isBucket) {
    const cols = ["库", "表名", "模型", "分区键", "分桶键", "分桶数", "总行数", "容量(GB)", "每桶行数"];
    return `
      <div class="gov-table-wrap"><table class="data-table">
        <thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
        <tbody>
          ${rows.map((r) => {
            const pk = r.PARTITION_KEY || r.partition_key;
            return `
            <tr>
              <td>${escapeHtml(r.TABLE_SCHEMA || r.table_schema)}</td>
              <td>${escapeHtml(r.TABLE_NAME || r.table_name)}</td>
              <td>${escapeHtml(r.TABLE_MODEL || "")}</td>
              <td>${pk ? escapeHtml(String(pk).replace(/`/g, "")) : `<span class="bad">无分区</span>`}</td>
              <td>${escapeHtml(r.DISTRIBUTE_KEY || "")}</td>
              <td><span class="bad">${Number(r.DISTRIBUTE_BUCKET ?? 0)}</span></td>
              <td>${Number(r.TABLE_ROWS ?? 0).toLocaleString()}</td>
              <td>${Number(r.DATA_SIZE_GB ?? r.size_gb ?? 0).toFixed(2)}</td>
              <td>${Number(r.ROWS_PER_BUCKET ?? 0).toLocaleString()}</td>
            </tr>
          `;}).join("")}
        </tbody>
      </table></div>
      <div class="muted">共 ${rows.length} 张分桶不合理的表（HASH 分桶≤10 且每桶行数≥1000万）。<span class="bad">无分区</span> 表查询无裁剪，最优先调整；有分区表会按分区裁剪，严重性相对低。</div>
    `;
  }
  const totalGb = rows.reduce((s, r) => s + (Number(r.size_gb) || 0), 0);
  return `
    <div class="gov-table-wrap"><table class="data-table">
      <thead>
        <tr><th>库</th><th>表名</th><th>行数</th><th>容量(GB)</th><th>创建时间</th></tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${escapeHtml(r.table_schema)}</td>
            <td>${escapeHtml(r.table_name)}</td>
            <td>${Number(r.table_rows ?? 0).toLocaleString()}</td>
            <td>${Number(r.size_gb ?? 0).toFixed(3)}</td>
            <td>${escapeHtml(String(r.create_time ?? "").slice(0, 10))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table></div>
    <div class="muted">合计 ${rows.length} 张 · ${totalGb.toFixed(1)} GB</div>
  `;
}

function renderHealth(health) {
  if (!health) return `<div data-gov-health>检查后端…</div>`;
  return `<div data-gov-health>
    ${health.toolsExist ? `<span class="ok">✓ Pi 包就绪</span>` : `<span class="bad">✗ Pi 包缺失</span>`}
  </div>`;
}

/**
 * Nightingale (夜莺) v8 API 客户端。
 *
 * 认证：API Token + `X-User-Token` 请求头（夜莺 v8 的 API Token 认证头，
 * 不是 Authorization: Bearer）。
 *
 * 用法：
 *   const client = new NightingaleClient({ baseUrl, token });
 *   const alerts = await client.getActiveAlerts({ busiGroup: 18 });
 */
import { fetchCompatible } from "./fetch-compatible.mjs";

export class NightingaleClient {
  constructor({ baseUrl, token, timeoutMs = 20000 } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.token = token || "";
    this.timeoutMs = timeoutMs;
  }

  /** 统一 GET 请求，返回夜莺的 dat 字段。 */
  async get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return this.#request(url.toString());
  }

  /** 统一 POST 请求，返回夜莺的 dat 字段。 */
  async post(path, body = {}) {
    const url = this.baseUrl + path;
    return this.#request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetchCompatible(url, {
        ...options,
        headers: {
          Accept: "application/json",
          "User-Agent": "znzb-alert-center/1.0",
          "X-User-Token": this.token,
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new Error("夜莺鉴权失败(401)：请检查 N9E_TOKEN（夜莺 API Token 用 X-User-Token 头，非 Bearer）");
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`夜莺请求失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      const payload = await response.json().catch(() => ({}));
      if (payload?.err) {
        throw new Error(`夜莺返回错误: ${payload.err}`);
      }
      return payload?.dat;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // 告警
  // ---------------------------------------------------------------------------

  /** 活跃告警。返回 dat.list[]，可选按业务组/严重级别过滤。 */
  async getActiveAlerts({ busiGroup, severity, limit = 200 } = {}) {
    const dat = await this.get("/api/n9e/alert-cur-events/list", {
      limit,
      cur_page: 1,
    });
    let list = Array.isArray(dat) ? dat : dat?.list || [];
    if (busiGroup) {
      list = list.filter((item) => Number(item.group_id) === Number(busiGroup));
    }
    if (severity !== undefined && severity !== null && severity !== "") {
      list = list.filter((item) => Number(item.severity) === Number(severity));
    }
    return list;
  }

  /** 历史告警。stime/etime 为 Unix 秒。 */
  async getHistoryAlerts({ stime, etime, limit = 200, page = 1 } = {}) {
    const dat = await this.get("/api/n9e/alert-his-events/list", {
      limit,
      cur_page: page,
      stime,
      etime,
    });
    return dat || {};
  }

  /** 业务组列表。 */
  async getBusiGroups() {
    return this.get("/api/n9e/busi-groups");
  }

  /** 某业务组的告警规则。 */
  async getAlertRules(busiGroup) {
    if (!busiGroup) {
      return [];
    }
    const dat = await this.get(`/api/n9e/busi-group/${busiGroup}/alert-rules`);
    return Array.isArray(dat) ? dat : [];
  }

  /** 数据源列表。 */
  async getDatasources() {
    return this.get("/api/n9e/datasource/brief");
  }

  /** 通知规则（谁接收电话/群消息）。 */
  async getNotifyRules() {
    return this.get("/api/n9e/notify-rules");
  }

  /** 通知渠道配置（电话/短信/钉钉等）。 */
  async getNotifyChannelConfigs() {
    return this.get("/api/n9e/notify-channel-configs");
  }

  /** 监控目标。 */
  async getTargets({ busiGroup, limit = 200 } = {}) {
    const dat = await this.get("/api/n9e/targets", {
      limit,
      cur_page: 1,
      bgids: busiGroup,
    });
    return Array.isArray(dat) ? dat : dat?.list || [];
  }

  /** 用户列表。 */
  async getUsers() {
    const dat = await this.get("/api/n9e/users", { limit: 200, cur_page: 1 });
    return Array.isArray(dat) ? dat : dat?.list || [];
  }

  // ---------------------------------------------------------------------------
  // 告警规则写入（配置能力）
  // ---------------------------------------------------------------------------

  /** 新建告警规则。body 为夜莺 alert-rule 对象。 */
  async createAlertRule(busiGroup, body) {
    const payload = { group_id: busiGroup, ...body };
    return this.post("/api/n9e/alert-rules", payload);
  }

  /** 更新告警规则（含启停：disabled 0/1）。 */
  async updateAlertRule(ruleId, body) {
    return this.post(`/api/n9e/alert-rules/${ruleId}`, body);
  }

  /** 启用/停用告警规则。 */
  async setAlertRuleDisabled(ruleId, disabled) {
    return this.updateAlertRule(ruleId, { disabled: disabled ? 1 : 0 });
  }
}

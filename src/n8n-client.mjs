/**
 * n8n API 客户端。
 *
 * 认证：API Key + `X-N8N-API-KEY` 请求头。
 *
 * 用法：
 *   const client = new N8nClient({ baseUrl, apiKey });
 *   const workflows = await client.listWorkflows({ active: true });
 */
import { fetchCompatible } from "./fetch-compatible.mjs";

export class N8nClient {
  constructor({ baseUrl, apiKey, timeoutMs = 20000 } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.timeoutMs = timeoutMs;
  }

  async #request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = path.startsWith("http") ? path : this.baseUrl + path;
      const response = await fetchCompatible(url, {
        ...options,
        headers: {
          Accept: "application/json",
          "User-Agent": "znzb-alert-center/1.0",
          "X-N8N-API-KEY": this.apiKey,
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new Error("n8n 鉴权失败(401)：请检查 N8N_API_KEY");
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`n8n 请求失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return response.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 工作流列表。返回 { data, nextCursor } 或数组（取决于 n8n 版本）。 */
  async listWorkflows({ active, limit = 100, cursor } = {}) {
    const params = new URLSearchParams();
    if (active !== undefined) params.set("active", String(active));
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const payload = await this.#request(`/api/v1/workflows?${params.toString()}`);
    return Array.isArray(payload) ? { data: payload } : payload;
  }

  /** 工作流详情（含节点）。 */
  async getWorkflow(id) {
    return this.#request(`/api/v1/workflows/${id}`);
  }

  /** 执行记录。 */
  async listExecutions({ workflowId, status, limit = 50, cursor } = {}) {
    const params = new URLSearchParams();
    if (workflowId) params.set("workflowId", String(workflowId));
    if (status) params.set("status", String(status));
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const payload = await this.#request(`/api/v1/executions?${params.toString()}`);
    return Array.isArray(payload) ? { data: payload } : payload;
  }

  /** 执行详情。includeData=true 可拿出错节点/SQL。 */
  async getExecution(id, { includeData = false } = {}) {
    const params = new URLSearchParams();
    if (includeData) params.set("includeData", "true");
    const query = params.toString();
    return this.#request(`/api/v1/executions/${id}${query ? `?${query}` : ""}`);
  }

  /** 激活的工作流 webhook 绑定（列表接口返回的 webhook 字段）。 */
  async listActiveWebhooks() {
    return this.listWorkflows({ active: true, limit: 200 });
  }
}

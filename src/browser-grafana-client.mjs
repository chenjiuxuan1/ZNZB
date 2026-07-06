import path from "node:path";

export class BrowserGrafanaClient {
  static async create(config) {
    const client = new BrowserGrafanaClient(config);
    try {
      await client.open();
    } catch (error) {
      await client.close?.();
      throw error;
    }
    return client;
  }

  constructor(config) {
    this.config = config;
    this.baseUrl = config.grafana.baseUrl.replace(/\/$/, "");
    this.orgId = config.grafana.orgId;
    this.timeoutMs = (config.grafana.requestTimeoutSeconds || 15) * 1000;
    this.context = null;
    this.page = null;
  }

  async open() {
    const { chromium } = await import("playwright-core");
    const userDataDir = path.resolve(this.config.browserAuth.userDataDir || ".state/chrome-profile");
    const headless = this.config.browserAuth.apiHeadless !== false;

    this.log(`启动 Chrome 页面内 API 客户端，headless=${headless}`);
    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      executablePath: this.config.browserAuth.executablePath,
      ignoreHTTPSErrors: true,
      args: ["--no-sandbox"],
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.primeOrigin();
  }

  async close() {
    await this.context?.close();
  }

  async getDashboardByUid(uid) {
    return this.requestJson(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  }

  async queryData(queries, timeRange) {
    return this.requestJson("/api/ds/query", {
      method: "POST",
      body: JSON.stringify({
        from: `${timeRange.fromMs}`,
        to: `${timeRange.toMs}`,
        queries,
      }),
    });
  }

  async requestJson(pathname, options = {}) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    };

    if (this.orgId !== undefined) {
      headers["X-Grafana-Org-Id"] = `${this.orgId}`;
    }

    const response = await this.page.evaluate(
      async ({ body, headers: requestHeaders, method, timeoutMs, url }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const result = await fetch(url, {
            body,
            credentials: "include",
            headers: requestHeaders,
            method,
            signal: controller.signal,
          });
          return {
            ok: result.ok,
            status: result.status,
            statusText: result.statusText,
            contentType: result.headers.get("content-type") || "",
            text: await result.text(),
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        body: options.body,
        headers,
        method: options.method || "GET",
        timeoutMs: this.timeoutMs,
        url: `${this.baseUrl}${pathname}`,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Browser Grafana request failed (${response.status} ${response.statusText}): ${response.text.slice(0, 240)}`,
      );
    }

    if (!response.contentType.includes("application/json")) {
      throw new Error(
        `Browser expected JSON but got ${response.contentType || "unknown content type"}: ${response.text.slice(0, 240)}`,
      );
    }

    return JSON.parse(response.text);
  }

  async primeOrigin() {
    const healthUrl = `${this.baseUrl}/api/health`;
    const warmupUrl = this.config.browserAuth?.authWarmupUrl || this.config.grafana.dashboardUrl || healthUrl;
    this.log("打开 Grafana 域名以建立浏览器同源上下文");

    for (const url of uniqueUrls([warmupUrl, this.config.grafana.dashboardUrl, healthUrl, this.baseUrl])) {
      await this.page.goto(url, {
        waitUntil: "commit",
        timeout: this.timeoutMs,
      }).catch((error) => {
        this.log(`建立同源上下文时页面加载失败：${error.message}`);
      });

      if (this.page.url().startsWith(this.baseUrl)) {
        break;
      }
    }

    if (!this.page.url().startsWith(this.baseUrl)) {
      throw new Error("Chrome did not enter the Grafana origin, cannot run in-page API requests.");
    }
  }

  log(message) {
    if (this.config.silent) {
      return;
    }
    console.error(`[discover] ${message}`);
  }
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

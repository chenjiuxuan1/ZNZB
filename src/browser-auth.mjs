import path from "node:path";
import { access } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { readJsonFile } from "./utils.mjs";

const DEFAULT_LOGIN_TIMEOUT_MS = 45_000;

export async function ensureGrafanaCookie(config) {
  if (config.grafana.cookie) {
    logStep(config, "使用环境变量里的 Grafana Cookie");
    return config.grafana.cookie;
  }

  const storageCookie = await loadCookieFromStorageState(config);
  if (storageCookie) {
    logStep(config, "复用本地已保存的浏览器登录态");
    config.grafana.cookie = storageCookie;
    return storageCookie;
  }

  if (!config.browserAuth?.enabled || !config.grafana.username) {
    logStep(config, "没有可用浏览器登录配置，跳过浏览器登录");
    return null;
  }

  logStep(config, "没有可复用登录态，准备启动 Chrome 登录 Grafana");
  const cookieHeader = await loginAndPersistSession(config, { manual: false });
  config.grafana.cookie = cookieHeader;
  return cookieHeader;
}

export async function saveBrowserLogin(config) {
  await loginAndPersistSession(config, { manual: true });
}

export function buildCookieHeader(cookies, baseUrl) {
  const { hostname } = new URL(baseUrl);
  const nowSeconds = Math.floor(Date.now() / 1000);

  return cookies
    .filter((cookie) => {
      const domain = (cookie.domain || "").replace(/^\./, "");
      const domainMatches = hostname === domain || hostname.endsWith(`.${domain}`);
      const notExpired = cookie.expires === -1 || cookie.expires === undefined || cookie.expires > nowSeconds;
      return domainMatches && notExpired;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function loadCookieFromStorageState(config) {
  const storageStateFile = path.resolve(config.browserAuth.storageStateFile);

  try {
    await access(storageStateFile);
  } catch {
    return null;
  }

  const storageState = await readJsonFile(storageStateFile);
  const cookieHeader = buildCookieHeader(storageState.cookies || [], config.grafana.baseUrl);
  return cookieHeader || null;
}

async function loginAndPersistSession(config, { manual }) {
  const { chromium } = await import("playwright-core");
  const loginTimeoutMs = getLoginTimeoutMs(config);
  const headless = manual ? false : config.browserAuth.headless !== false;
  const userDataDir = path.resolve(config.browserAuth.userDataDir || ".state/chrome-profile");
  logStep(config, `启动 Chrome，headless=${headless}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: config.browserAuth.executablePath,
    ignoreHTTPSErrors: true,
    args: ["--no-sandbox"],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const loginUrl = config.grafana.dashboardUrl || `${config.grafana.baseUrl}/login`;
    logStep(config, `打开 Grafana 页面，最多等待 ${loginTimeoutMs / 1000}s`);
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: loginTimeoutMs,
    }).catch((error) => {
      if (!manual) {
        throw error;
      }
      logStep(config, `页面自动加载超时：${error.message}`);
      logStep(config, "如果 Chrome 已打开，请在窗口里手动刷新或粘贴报表链接登录");
    });

    if (manual) {
      await waitForManualLogin(config);
    } else {
      logStep(config, "页面已开始加载，尝试识别登录表单");
      await maybeFillLoginForm(page, config);

      logStep(config, "等待登录完成或页面稳定");
      await Promise.race([
        page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: loginTimeoutMs }),
        page.waitForLoadState("networkidle", { timeout: loginTimeoutMs }),
      ]);
    }

    const storageStateFile = path.resolve(config.browserAuth.storageStateFile);
    await context.storageState({ path: storageStateFile });
    const cookieHeader = buildCookieHeader(await context.cookies(), config.grafana.baseUrl);

    if (!cookieHeader) {
      throw new Error("Browser login finished, but no Grafana cookies were captured.");
    }

    logStep(config, "已保存 Grafana 浏览器登录态");
    return cookieHeader;
  } finally {
    await context.close();
  }
}

async function maybeFillLoginForm(page, config) {
  const userLocator = await firstVisibleLocator(page, [
    "input[name='user']",
    "input[name='username']",
    "input[type='email']",
    "input[autocomplete='username']",
  ]);

  const passwordLocator = await firstVisibleLocator(page, [
    "input[name='password']",
    "input[type='password']",
    "input[autocomplete='current-password']",
  ]);

  if (!userLocator || !passwordLocator) {
    logStep(config, "没有识别到标准登录表单，可能已登录或被网关拦截");
    return;
  }

  logStep(config, "识别到登录表单，正在提交账号密码");
  await userLocator.fill(config.grafana.username);
  await passwordLocator.fill(config.grafana.password || "");

  const submitLocator = await firstVisibleLocator(page, [
    "button[type='submit']",
    "button[aria-label='Login button']",
    "input[type='submit']",
  ]);

  if (!submitLocator) {
    throw new Error("Login form found, but submit button was not found.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded", {
      timeout: getLoginTimeoutMs(config),
    }).catch(() => {}),
    submitLocator.click(),
  ]);
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0 && (await locator.first().isVisible().catch(() => false))) {
      return locator.first();
    }
  }

  return null;
}

async function waitForManualLogin(config) {
  logStep(config, "请在弹出的 Chrome 中完成登录并打开报表");
  const rl = createInterface({ input, output });
  try {
    await rl.question("登录完成后回到这里按 Enter 保存登录态...");
  } finally {
    rl.close();
  }
}

function getLoginTimeoutMs(config) {
  return (config.browserAuth.loginTimeoutSeconds || DEFAULT_LOGIN_TIMEOUT_MS / 1000) * 1000;
}

function logStep(config, message) {
  if (config.silent) {
    return;
  }
  console.error(`[discover] ${message}`);
}

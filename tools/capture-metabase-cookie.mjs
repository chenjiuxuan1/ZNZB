#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const rootDir = path.resolve(import.meta.dirname, "..");
const envFile = path.join(rootDir, ".env");
const userDataDir = path.join(rootDir, ".state", "metabase-profile");
const executablePath = process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const targetUrl = process.argv[2] || "https://data.kuainiu.io/dashboard/462?date_filter=past1days~";
const timeoutMs = Number(process.env.METABASE_COOKIE_CAPTURE_TIMEOUT_MS || 180_000);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  executablePath,
  ignoreHTTPSErrors: true,
  args: ["--no-sandbox"],
});

try {
  const page = context.pages()[0] || await context.newPage();
  console.error(`[metabase] 打开 ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
    console.error(`[metabase] 页面加载提示：${error.message}`);
  });

  const session = await waitForSessionCookie(context, timeoutMs);
  await upsertEnv(envFile, "METABASE_SESSION", session.value);
  console.error("[metabase] 已捕获 metabase.SESSION 并写入 .env");
} finally {
  await context.close();
}

async function waitForSessionCookie(context, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cookies = await context.cookies("https://data.kuainiu.io");
    const session = cookies.find((cookie) => cookie.name === "metabase.SESSION" && cookie.value);
    if (session) {
      return session;
    }
    console.error("[metabase] 等待登录态，请在打开的浏览器中完成登录...");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("未在超时时间内捕获 metabase.SESSION，请确认浏览器里已完成 Metabase 登录。");
}

async function upsertEnv(filePath, key, value) {
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const line = `${key}=${shellQuoteEnv(value)}`;
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((rawLine) => {
    if (rawLine.startsWith(`${key}=`)) {
      replaced = true;
      return line;
    }
    return rawLine;
  });
  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(line);
  }

  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function shellQuoteEnv(value) {
  return JSON.stringify(String(value));
}

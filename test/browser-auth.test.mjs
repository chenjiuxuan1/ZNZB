import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildCookieHeader } from "../src/browser-auth.mjs";

test("buildCookieHeader keeps matching non-expired cookies", () => {
  const cookieHeader = buildCookieHeader(
    [
      {
        name: "grafana_session",
        value: "abc",
        domain: "sr-monitor.empoweroceanin.com",
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        name: "other",
        value: "skip",
        domain: "example.com",
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
    "https://sr-monitor.empoweroceanin.com",
  );

  assert.equal(cookieHeader, "grafana_session=abc");
});

test("browser auth avoids Node 18-only readline promises import", async () => {
  const source = await readFile(new URL("../src/browser-auth.mjs", import.meta.url), "utf8");

  assert.equal(source.includes("node:readline/promises"), false);
});

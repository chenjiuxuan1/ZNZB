import test from "node:test";
import assert from "node:assert/strict";
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

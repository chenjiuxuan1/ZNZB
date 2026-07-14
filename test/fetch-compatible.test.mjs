import assert from "node:assert/strict";
import test from "node:test";
import { fetchCompatible } from "../src/fetch-compatible.mjs";
import { MetabaseInternalClient } from "../src/metabase-internal-client.mjs";

test("Node 16 compatible clients do not require global fetch at construction time", (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new MetabaseInternalClient({
    baseUrl: "https://metabase.example.com",
    sessionToken: "test-session",
  });

  assert.equal(typeof fetchCompatible, "function");
  assert.equal(typeof client.fetchFn, "function");
});

test("fetchCompatible prefers the current global fetch when available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => ({ ok: true, url, options });
  try {
    const response = await fetchCompatible("https://example.com/api", { method: "POST" });
    assert.equal(response.ok, true);
    assert.equal(response.url, "https://example.com/api");
    assert.equal(response.options.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicDashboardUrl } from "../src/metabase-public-client.mjs";
import { extractPublicDashboardRefs } from "../src/metabase-discovery.mjs";

test("parsePublicDashboardUrl extracts base url and uuid", () => {
  assert.deepEqual(
    parsePublicDashboardUrl("https://data.kuainiu.io/public/dashboard/abc-123"),
    {
      baseUrl: "https://data.kuainiu.io",
      uuid: "abc-123",
      url: "https://data.kuainiu.io/public/dashboard/abc-123",
    },
  );
});

test("extractPublicDashboardRefs dedupes links", () => {
  const refs = extractPublicDashboardRefs({
    panels: [
      {
        id: 1,
        title: "A",
        links: [
          { url: "https://data.kuainiu.io/public/dashboard/abc-123" },
          { url: "https://data.kuainiu.io/public/dashboard/abc-123" },
        ],
      },
    ],
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].sourcePanelTitle, "A");
});

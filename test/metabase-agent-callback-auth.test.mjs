import assert from "node:assert/strict";
import test from "node:test";
import { assertMetabaseAgentCallbackAuthorized, safeTokenEquals } from "../src/metabase-agent-callback-auth.mjs";

const env = { METABASE_ANOMALY_AGENT_CALLBACK_TOKEN: "callback-test-token" };
const authorizedRequest = { headers: { authorization: "Bearer callback-test-token" } };

test("Metabase callback authorization requires a configured matching bearer token", () => {
  assert.doesNotThrow(() => assertMetabaseAgentCallbackAuthorized(authorizedRequest, { jobId: "job-1" }, env));
  for (const [request, body, settings] of [
    [{ headers: {} }, { jobId: "job-1" }, env],
    [{ headers: { authorization: "Bearer wrong-token" } }, { jobId: "job-1" }, env],
    [authorizedRequest, { jobId: "job-1" }, {}],
    [{ headers: {} }, { jobId: "unguessable-job-id-is-not-auth" }, {}],
  ]) {
    assert.throws(() => assertMetabaseAgentCallbackAuthorized(request, body, settings), (error) => error.statusCode === 401);
  }
});

test("Metabase callback token comparison is exact and safe for unequal lengths", () => {
  assert.equal(safeTokenEquals("same", "same"), true);
  assert.equal(safeTokenEquals("same", "different"), false);
  assert.equal(safeTokenEquals("short", "longer"), false);
});

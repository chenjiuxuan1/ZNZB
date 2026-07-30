import { timingSafeEqual } from "node:crypto";

export function assertMetabaseAgentCallbackAuthorized(request, body = {}, env = process.env) {
  const expected = String(env.METABASE_ANOMALY_AGENT_CALLBACK_TOKEN || "").trim();
  const received = String(request?.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();

  if (!expected || !received || !safeTokenEquals(received, expected)) {
    const error = new Error("Unauthorized Metabase Agent callback");
    error.statusCode = 401;
    throw error;
  }

  // Keep the argument in the function contract: callback identity validation is
  // performed by the platform API after authentication. A jobId is never an
  // authorization capability.
  void body;
}

export function safeTokenEquals(received, expected) {
  const actualBuffer = Buffer.from(String(received));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

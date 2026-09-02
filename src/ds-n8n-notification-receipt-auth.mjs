import { timingSafeEqual } from "node:crypto";

export function assertDsN8nNotificationReceiptAuthorized(receivedToken, expectedToken) {
  const received = String(receivedToken || "").replace(/^Bearer\s+/i, "").trim();
  const expected = String(expectedToken || "").trim();
  if (!received || !expected || !safeTokenEquals(received, expected)) {
    const error = new Error("Unauthorized DS n8n notification receipt");
    error.statusCode = 401;
    throw error;
  }
}

export function safeTokenEquals(received, expected) {
  const receivedBuffer = Buffer.from(String(received));
  const expectedBuffer = Buffer.from(String(expected));
  if (receivedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

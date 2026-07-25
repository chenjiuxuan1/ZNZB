import assert from "node:assert/strict";
import test from "node:test";
import { readJsonRequestBody } from "../src/utils.mjs";

test("readJsonRequestBody rejects payloads larger than its configured limit", async () => {
  const request = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("12345");
      yield Buffer.from("67890");
    },
  };

  await assert.rejects(
    () => readJsonRequestBody(request, { maxBytes: 8 }),
    (error) => error.statusCode === 413 && error.message === "Request body too large",
  );
});

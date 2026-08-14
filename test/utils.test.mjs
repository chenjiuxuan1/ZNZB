import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonRequestBody, writeJsonFileAtomic } from "../src/utils.mjs";

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

test("concurrent atomic JSON writes all complete without temporary-file collisions", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-json-"));
  const filePath = path.join(rootDir, "state.json");

  const results = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) => writeJsonFileAtomic(filePath, { index })),
  );

  assert.equal(results.filter((item) => item.status === "rejected").length, 0);
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.ok(Number.isInteger(saved.index));
});

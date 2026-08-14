#!/usr/bin/env node

import path from "node:path";
import { cleanupLegacyDashboardUrls } from "../src/history-dashboard-url-cleanup.mjs";

const options = parseArguments(process.argv.slice(2));
const report = await cleanupLegacyDashboardUrls({
  rootDir: options.rootDir,
  dryRun: options.dryRun,
});
console.log(JSON.stringify(report, null, 2));

function parseArguments(args) {
  let rootDir = process.cwd();
  let dryRun = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      dryRun = true;
    } else if (argument === "--apply") {
      dryRun = false;
    } else if (argument === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root requires a directory path");
      rootDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { rootDir, dryRun };
}

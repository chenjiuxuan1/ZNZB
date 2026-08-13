# Runtime Functional Risk Fixes Design

Date: 2026-08-13

## Goal

Fix the confirmed scheduler and JSON persistence defects without changing API paths, request or response shapes, patrol rules, notification content, dashboard scope, or stored business data.

## Scope

The change covers five related runtime defects:

1. Start the already implemented standalone DS scheduler when the server starts.
2. Prevent manual and scheduled DS or HIVE runs from overlapping in one process.
3. Advance `nextRunAt` after a failed scheduled DS or HIVE run so a persistent fault does not retry every minute.
4. Make atomic JSON temporary file names collision-safe and serialize read-modify-write updates for shared AI and history stores.
5. Save DS and HIVE configuration through the existing atomic JSON writer.

It does not change authentication, webhook policy, credentials, Metabase URL cleanup, anomaly algorithms, retention limits, or notification routing.

## Design

### Scheduler startup and mutual exclusion

`src/server.mjs` will invoke `startDsScheduler()` next to the existing batch and HIVE startup calls.

`createPlatformApi()` will own separate DS and HIVE running flags. Both manual and due-run entry points will acquire the same per-scheduler flag before executing. A second manual request will receive the existing bad-request style error. A due tick will return `ran: false` with an `already running` reason. Flags are cleared in `finally`, including failures.

The existing batch scheduler guard remains unchanged. DS due runs will continue to defer while the integrated batch patrol is running. HIVE will receive the equivalent batch guard so the standalone HIVE schedule cannot overlap the integrated HIVE stage.

### Failure scheduling

Every scheduled DS or HIVE attempt calculates its following execution time from the completion clock and configured interval. Success and failure both persist that future value. Manual runs retain the schedule's existing `nextRunAt`, so a manual test does not shift the automatic timetable.

Validation failures that currently occur before the schedule runner's `try` block will be moved inside the persisted failure path. They will write `lastError`, append one failed history entry, and advance the next scheduled run when the trigger is `schedule`.

### JSON persistence

The atomic writer will generate a unique temporary name using a UUID in addition to the process identifier. It will clean up its own temporary file if writing or renaming fails.

Uniqueness prevents temporary-file collisions but does not prevent lost read-modify-write updates. A small per-file promise queue will therefore serialize update operations for shared JSON stores. The initial consumers will be:

- Metabase anomaly analyses and evidence snapshots
- pending Metabase patrol runs
- batch, DS, and HIVE histories

The updater reads the latest value inside the queue, applies a synchronous transformation, and atomically writes the result. Existing retention and deduplication functions remain the source of truth.

Direct writes that replace an entire configuration or schedule remain atomic but do not need the update queue.

### DS and HIVE configuration writes

`saveDsSchedulerConfig()` and `saveHiveSchedulerConfig()` will use `writeJsonFileAtomic()` from `src/utils.mjs`. Their returned objects and on-disk JSON structure remain unchanged.

## Error handling

- Atomic write failures preserve the previous destination file and remove only the failed operation's temporary file.
- A concurrent manual scheduler request fails before performing external calls or sending notifications.
- Scheduled failures are recorded once per configured interval rather than once per server tick.
- Queue failures do not poison later updates; the queue tail always recovers before accepting the next operation.

## Tests

Tests will be written before production changes and must demonstrate:

- server startup invokes all three schedulers;
- concurrent atomic writes do not fail;
- concurrent updates to different analysis/history entries preserve both entries;
- DS and HIVE scheduled failures advance `nextRunAt` and append one failure record;
- manual failures do not shift a future automatic run;
- overlapping DS and HIVE runs are rejected or skipped without duplicate external calls;
- DS and HIVE configuration saves remain byte-valid JSON with unchanged schema;
- the complete existing test suite remains green.

## Rollout and compatibility

No server environment variables or data migration are required. Deployment uses the existing pull, restart, summary check, and batch-history check process. Existing schedule and history JSON files remain readable. The first DS standalone tick runs only when its saved schedule is enabled and due.

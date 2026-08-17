const FALSE_VALUES = new Set(["0", "false", "off", "no", ""]);

export function getMetabaseAnomalyAccelerationSettings(env = process.env) {
  const enabled = !FALSE_VALUES.has(String(env.METABASE_ANOMALY_AGENT_ACCELERATION_ENABLED || "").trim().toLowerCase());
  // This path submits independent Agent calls, so it shares the same bounded
  // two-request ceiling as the dashboard batch queue.
  const maxConcurrency = clamp(env.METABASE_ANOMALY_AGENT_ACCELERATION_MAX_CONCURRENCY, 2, 1, 2);
  const snapshotTtlSeconds = clamp(env.METABASE_ANOMALY_AGENT_SNAPSHOT_TTL_SECONDS, 600, 60, 900);
  return { enabled, maxConcurrency, snapshotTtlSeconds };
}

export function createBoundedTaskQueue({ concurrency = 2 } = {}) {
  const limit = clamp(concurrency, 2, 1, 2);
  const pending = [];
  let active = 0;
  const runNext = () => {
    while (active < limit && pending.length) {
      const { task, resolve, reject } = pending.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        runNext();
      });
    }
  };
  return {
    add(task) {
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        runNext();
      });
    },
    get size() { return pending.length; },
    get active() { return active; },
  };
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

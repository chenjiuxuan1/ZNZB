import path from "node:path";
import { readJsonFile, writeJsonFile } from "./utils.mjs";

export async function loadState(stateFile) {
  const state = await readJsonFile(path.resolve(stateFile), { active: {} });
  return {
    active: state.active || {},
  };
}

export async function saveState(stateFile, state) {
  await writeJsonFile(path.resolve(stateFile), state);
}

export function diffActiveAnomalies(previousState, anomalies) {
  const nextActive = {};
  const newAnomalies = [];
  const recoveries = [];

  for (const anomaly of anomalies) {
    nextActive[anomaly.fingerprint] = anomaly;
    if (!previousState.active[anomaly.fingerprint]) {
      newAnomalies.push(anomaly);
    }
  }

  for (const [fingerprint, anomaly] of Object.entries(previousState.active)) {
    if (!nextActive[fingerprint]) {
      recoveries.push(anomaly);
    }
  }

  return {
    nextState: { active: nextActive },
    newAnomalies,
    recoveries,
  };
}


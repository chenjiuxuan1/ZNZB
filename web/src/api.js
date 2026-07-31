export async function apiGet(path, options = {}) {
  return request(path, { method: "GET", ...options });
}

export async function apiPut(path, body) {
  return request(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function apiPost(path, body = {}) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

async function request(path, options) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const response = await fetch(path, {
    ...options,
    signal: controller?.signal || options.signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).catch((error) => {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

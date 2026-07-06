export async function apiGet(path) {
  return request(path, { method: "GET" });
}

export async function apiPut(path, body) {
  return request(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function apiPost(path, body = {}) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

import http from "node:http";
import https from "node:https";

export function fetchCompatible(url, options = {}) {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch(url, options);
  }
  return nodeFetch(url, options);
}

function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const method = options.method || "GET";
    const { body, headers } = normalizeBodyAndHeaders(options.body, options.headers || {});
    let settled = false;

    const request = client.request(target, {
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        settled = true;
        resolve(new FetchCompatibleResponse({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
        }));
      });
    });

    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    if (options.signal) {
      if (options.signal.aborted) {
        request.destroy(abortError());
        return;
      }
      options.signal.addEventListener("abort", () => {
        request.destroy(abortError());
      }, { once: true });
    }

    if (body !== undefined && body !== null) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeBodyAndHeaders(body, inputHeaders) {
  const headers = normalizeHeaders(inputHeaders);
  if (body === undefined || body === null) {
    return { body: undefined, headers };
  }

  if (body instanceof URLSearchParams) {
    const text = body.toString();
    if (!hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
    headers["Content-Length"] = Buffer.byteLength(text);
    return { body: text, headers };
  }

  if (Buffer.isBuffer(body) || typeof body === "string") {
    headers["Content-Length"] = Buffer.byteLength(body);
    return { body, headers };
  }

  const text = String(body);
  headers["Content-Length"] = Buffer.byteLength(text);
  return { body: text, headers };
}

function normalizeHeaders(headers) {
  if (headers && typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries());
  }
  return { ...(headers || {}) };
}

function hasHeader(headers, name) {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

class FetchCompatibleResponse {
  constructor({ body, headers, status, statusText }) {
    this.body = body;
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = {
      get: (name) => getHeader(headers, name),
    };
  }

  async text() {
    return this.body.toString("utf8");
  }

  async json() {
    return JSON.parse(await this.text());
  }
}

function getHeader(headers, name) {
  const normalizedName = String(name || "").toLowerCase();
  const value = headers?.[normalizedName];
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return value || "";
}

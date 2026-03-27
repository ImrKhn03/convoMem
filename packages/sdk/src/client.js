'use strict';

const { ConvoMemError } = require('./errors');

/** Statuses that are safe to retry automatically. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Minimal fetch-based HTTP client with no external dependencies.
 */
class HttpClient {
  /**
   * @param {{ apiKey: string, baseUrl?: string, timeout?: number, maxRetries?: number, retryDelay?: number }} options
   */
  constructor({ apiKey, baseUrl = 'http://localhost:8000', timeout = 30000, maxRetries = 3, retryDelay = 1000 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Execute an HTTP request.
   *
   * @param {string} method          HTTP verb (GET, POST, DELETE, …)
   * @param {string} path            API path, e.g. '/api/memories'
   * @param {{ body?: object, params?: object }} [options]
   * @returns {Promise<any>}         Parsed JSON response body
   */
  async request(method, path, { body, params } = {}) {
    // Build URL
    let url = `${this.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      );
      url += `?${qs.toString()}`;
    }

    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Each attempt gets its own AbortController + timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      /** @type {RequestInit} */
      const init = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        signal: controller.signal,
      };

      if (bodyStr !== undefined) {
        init.body = bodyStr;
      }

      let resp;
      try {
        resp = await fetch(url, init);
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          if (attempt < this.maxRetries) continue;
          throw new ConvoMemError(
            `Request timed out after ${this.timeout}ms`,
            0,
            'TIMEOUT'
          );
        }
        // Network error — retry if attempts remain
        if (attempt < this.maxRetries) continue;
        throw new ConvoMemError(err.message || 'Network error', 0, 'NETWORK_ERROR');
      } finally {
        clearTimeout(timer);
      }

      // 202 Accepted is a success for async capture endpoints
      if (resp.ok || resp.status === 202) {
        if (resp.status === 204) return null;
        return resp.json();
      }

      // Retryable status — back off and retry
      if (RETRYABLE_STATUSES.has(resp.status) && attempt < this.maxRetries) {
        const retryAfter = resp.headers?.get?.('Retry-After');
        let delayMs;
        if (retryAfter && /^\d+$/.test(retryAfter)) {
          delayMs = parseInt(retryAfter, 10) * 1000;
        } else {
          delayMs = this.retryDelay * Math.pow(2, attempt);
        }
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      // Non-retryable or out of retries — throw
      let errBody = {};
      try {
        errBody = await resp.json();
      } catch {
        // ignore parse failure
      }

      throw new ConvoMemError(
        errBody.error || `Request failed with status ${resp.status}`,
        resp.status,
        errBody.code
      );
    }
  }

  /**
   * Convenience: GET request with optional query params.
   * @param {string} path
   * @param {object} [params]
   */
  get(path, params) {
    return this.request('GET', path, { params });
  }

  /**
   * Convenience: POST request with a JSON body.
   * @param {string} path
   * @param {object} [body]
   */
  post(path, body) {
    return this.request('POST', path, { body });
  }

  /**
   * Convenience: PATCH request with a JSON body.
   * @param {string} path
   * @param {object} [body]
   */
  patch(path, body) {
    return this.request('PATCH', path, { body });
  }

  /**
   * Convenience: DELETE request.
   * @param {string} path
   */
  delete(path) {
    return this.request('DELETE', path);
  }
}

module.exports = { HttpClient };

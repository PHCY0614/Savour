/**
 * The one function that calls api.notion.com: adds auth and version headers and retries rate limits
 * and server errors (only for requests that are safe to repeat).
 */
(function attachSavourNotionHttp(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SavourNotionHttp = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createNotionHttpModule() {
  "use strict";

  /**
   * @typedef {object} NotionHttpOptions
   * @property {typeof import("../lib/shared.js")} shared
   * @property {string} apiVersion Notion-Version header value
   * @property {typeof fetch} fetchImpl
   * @property {import("../types").Services["requireToken"]} requireToken used when a request gives no token
   */

  /**
   * @param {NotionHttpOptions} options
   */
  function createNotionHttp(options) {
    const { shared, apiVersion, fetchImpl, requireToken } = options;
    /**
     * @param {string} text
     * @param {Record<string, string | number>} [params]
     * @returns {string}
     */
    const t = (text, params) => (shared.t ? shared.t(text, params) : String(text).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match)));

    /**
     * Calls the Notion API and returns the parsed JSON. Throws an Error with `status` on a failed response.
     * @param {string} path e.g. "/v1/pages"
     * @param {{ method?: string, body?: unknown, token?: string, headers?: object, retrySafe?: boolean }} requestOptions `retrySafe` allows retrying on 429, 5xx and network errors
     * @returns {Promise<any>}
     */
    async function notionRequest(path, requestOptions) {
      const method = requestOptions.method ?? "GET";
      const token = requestOptions.token ?? await requireToken();
      const retrySafe = Boolean(requestOptions.retrySafe);
      const isFormData = typeof FormData !== "undefined" && requestOptions.body instanceof FormData;
      let attempt = 0;
      while (attempt < 5) {
        let response;
        try {
          /** @type {any} */ const headers = {
            Authorization: `Bearer ${token}`,
            "Notion-Version": apiVersion,
            ...(requestOptions.headers ?? {})
          };
          if (!isFormData && requestOptions.body !== undefined && !headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
          }
          response = await fetchImpl(`https://api.notion.com${path}`, {
            method,
            headers,
            body: requestOptions.body === undefined
              ? undefined
              : isFormData ? /** @type {FormData} */ (requestOptions.body) : JSON.stringify(requestOptions.body)
          });
        } catch (error) {
          if (!retrySafe || attempt >= 4) throw error;
          await shared.sleep(Math.min(2 ** attempt, 15) * 1000 + Math.random() * 200);
          attempt += 1;
          continue;
        }

        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { message: text };
        }
        if (response.ok) return data;

        const retryable = response.status === 429
          || (retrySafe && [500, 502, 503, 504, 529].includes(response.status));
        if (!retryable || attempt >= 4) {
          const error = new Error(data.message || t("Notion API 錯誤 {status}", { status: response.status }));
          error.code = data.code || `http_${response.status}`;
          error.status = response.status;
          throw error;
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitSeconds = Number.isFinite(retryAfter) ? retryAfter : Math.min(2 ** attempt, 30);
        await shared.sleep(waitSeconds * 1000 + Math.random() * 250);
        attempt += 1;
      }
      throw new Error(t("Notion API 重試次數已用完"));
    }

    return { notionRequest };
  }

  return { createNotionHttp };
});

/**
 * Thin HTTP client for the ACME facility incident API.
 *
 * The same URL shape works in both environments, which is why there is no
 * environment branching here:
 *
 * - AWS   `VITE_API_URL` is the CloudFront domain, and the `/api/facility-api`
 *         behaviour forwards to the Lambda with the prefix intact.
 * - Local `VITE_API_URL` is the dev proxy on :3001, which strips the same
 *         prefix before forwarding to the LocalStack Lambda URL.
 *
 * Both are generated into `.env.local` by `bin/generate-env.sh`.
 */

const SERVICE_PATH = '/api/facility-api';

const rawBase = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** Root URL of the incident API, including the service path. */
export const API_BASE = `${rawBase.replace(/\/$/, '')}${SERVICE_PATH}`;

/**
 * Error carrying the API's structured envelope.
 *
 * The backend answers every failure with
 * `{"error": {status, type, message, details}}`, so the UI can show
 * `message` directly and branch on `type` when it needs to.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} type Machine-readable error slug, e.g. `not_found`.
   * @param {string} message Human-readable message safe to display.
   * @param {*} [details] Optional structured context, such as field errors.
   */
  constructor(status, type, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.details = details;
  }

  /**
   * Flatten field-level validation details into a readable string.
   *
   * @returns {string} One line per failing field, or the plain message.
   */
  describe() {
    if (Array.isArray(this.details) && this.details.length > 0) {
      return this.details
        .map((detail) => `${String(detail.field).replace(/^body\./, '')}: ${detail.message}`)
        .join('; ');
    }
    return this.message;
  }
}

/**
 * Send a JSON request and unwrap the response.
 *
 * @param {string} path Path relative to the service root, e.g. `/incidents`.
 * @param {object} [options] Request options.
 * @param {string} [options.method] HTTP method, defaults to `GET`.
 * @param {object} [options.body] JSON body to send.
 * @param {string} [options.token] Bearer token for authenticated calls.
 * @returns {Promise<*>} The decoded response body, or `null` for 204.
 * @throws {ApiError} When the response status is not 2xx.
 */
export async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch only rejects on network-level failures, never on HTTP errors.
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection.', cause?.message);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = payload?.error ?? {};
    throw new ApiError(
      response.status,
      envelope.type ?? 'http_error',
      envelope.message ?? `Request failed with status ${response.status}`,
      envelope.details,
    );
  }
  return payload;
}

/**
 * Build a query string from defined, non-empty values.
 *
 * Empty filter fields are dropped so that "no filter" never reaches the API as
 * an empty-string parameter, which it would reject as a validation error.
 *
 * @param {object} params Candidate query parameters.
 * @returns {string} A `?a=1&b=2` string, or an empty string when nothing is set.
 */
export function toQuery(params) {
  const search = new URLSearchParams();
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.append(key, String(value));
    }
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * Tests for the HTTP client.
 *
 * These cover the behaviours the rest of the app depends on and that would
 * fail silently if changed: dropping empty filters from query strings,
 * unwrapping the API's error envelope, and treating a 204 as "no content"
 * rather than trying to parse it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, ApiError, request, toQuery } from './api';

/**
 * Install a fetch stub returning one canned response.
 *
 * @param {object} options Response shape.
 * @param {number} options.status HTTP status to return.
 * @param {*} [options.body] Value serialised as the response body.
 * @returns {import('vitest').Mock} The stubbed fetch.
 */
function stubFetch({ status, body }) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const mock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toQuery', () => {
  it('drops undefined, null and empty values', () => {
    // An empty filter must not reach the API: it rejects "" for enum
    // parameters with a 400, so a blank dropdown would break the list.
    expect(toQuery({ status: '', priority: undefined, category: null })).toBe('');
  });

  it('keeps values that are set, including falsy-but-meaningful ones', () => {
    const query = toQuery({ status: 'OPEN', offset: 0, unassigned: false });
    expect(query).toContain('status=OPEN');
    expect(query).toContain('offset=0');
    expect(query).toContain('unassigned=false');
  });

  it('returns an empty string rather than a bare question mark', () => {
    expect(toQuery({})).toBe('');
    expect(toQuery(undefined)).toBe('');
  });

  it('encodes values that need it', () => {
    expect(toQuery({ q: 'meeting room 3A' })).toBe('?q=meeting+room+3A');
  });
});

describe('request', () => {
  it('sends the bearer token when one is supplied', async () => {
    const mock = stubFetch({ status: 200, body: { ok: true } });
    await request('/auth/me', { token: 'abc123' });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/auth/me`);
    expect(init.headers.Authorization).toBe('Bearer abc123');
  });

  it('omits the Authorization header when there is no token', async () => {
    const mock = stubFetch({ status: 200, body: {} });
    await request('/health');
    expect(mock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('serialises a body and sets the content type', async () => {
    const mock = stubFetch({ status: 201, body: { id: 1 } });
    await request('/incidents', { method: 'POST', body: { title: 'Broken' } });
    const [, init] = mock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"Broken"}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns null for 204 instead of parsing an empty body', async () => {
    stubFetch({ status: 204 });
    await expect(request('/incidents/1', { method: 'DELETE' })).resolves.toBeNull();
  });

  it('unwraps the error envelope into an ApiError', async () => {
    stubFetch({
      status: 409,
      body: { error: { status: 409, type: 'invalid_transition', message: 'Cannot move', details: { allowed: ['OPEN'] } } },
    });
    await expect(request('/incidents/1/status', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      type: 'invalid_transition',
      message: 'Cannot move',
    });
  });

  it('still produces an ApiError when the body is not an envelope', async () => {
    stubFetch({ status: 500, body: { unexpected: true } });
    await expect(request('/health')).rejects.toMatchObject({
      status: 500,
      type: 'http_error',
    });
  });

  it('turns a network failure into a readable ApiError', async () => {
    // fetch rejects only on network-level failure, never on an HTTP error.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(request('/health')).rejects.toMatchObject({
      status: 0,
      type: 'network_error',
    });
  });
});

describe('ApiError.describe', () => {
  it('flattens field validation details and strips the body prefix', () => {
    const error = new ApiError(400, 'validation_error', 'Request payload failed validation', [
      { field: 'body.email', message: 'must belong to the @acme.inc domain' },
      { field: 'body.password', message: 'too short' },
    ]);
    expect(error.describe()).toBe(
      'email: must belong to the @acme.inc domain; password: too short',
    );
  });

  it('falls back to the plain message when there are no details', () => {
    expect(new ApiError(404, 'not_found', 'Incident 42 was not found').describe()).toBe(
      'Incident 42 was not found',
    );
  });
});

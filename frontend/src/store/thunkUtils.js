/**
 * Shared shape for rejected thunks.
 *
 * Thunks used to reject with a bare string, which was enough for a toast but
 * discarded the per-field detail the API sends with a validation failure.
 * Rejecting with `{message, fields}` keeps both: the message for the toast, and
 * the field map so a form can put each message beside the input it refers to.
 */

import { refreshSession } from './session';

// One renewal at a time. Several requests can fail together when a token
// expires, and each dispatching its own refresh would spend the rotating
// token more than once - which the API correctly treats as a replay and
// punishes by ending the session.
let renewal = null;

/**
 * Run an authenticated request, renewing the session once if it has expired.
 *
 * @param {object} thunkApi Redux Toolkit thunk API.
 * @param {Function} body Receives the bearer token and performs the request.
 * @returns {Promise<*>} The resolved payload, or a rejection with a message.
 */
export async function withAuth(thunkApi, body) {
  const { getState, dispatch, rejectWithValue } = thunkApi;
  try {
    return await body(getState().auth.token);
  } catch (error) {
    if (error?.type !== 'token_expired') return rejectWithValue(rejectValue(error));

    try {
      if (!renewal) {
        renewal = dispatch(refreshSession())
          .unwrap()
          .finally(() => {
            renewal = null;
          });
      }
      await renewal;
    } catch {
      // Renewal failed; the original expiry is the useful message.
      return rejectWithValue(rejectValue(error));
    }

    try {
      // Retried once only: a second expiry means something else is wrong.
      return await body(getState().auth.token);
    } catch (retryError) {
      return rejectWithValue(rejectValue(retryError));
    }
  }
}

/**
 * Convert an ApiError into the value a thunk rejects with.
 *
 * @param {import('../services/api').ApiError} error The caught error.
 * @returns {{message: string, fields: Object<string, string>}} Rejection value.
 */
export function rejectValue(error) {
  return {
    message: typeof error?.describe === 'function' ? error.describe() : String(error),
    fields: typeof error?.fieldErrors === 'function' ? error.fieldErrors() : {},
  };
}

/**
 * Read the human-readable message from a rejected thunk's payload.
 *
 * @param {*} payload The rejection payload.
 * @param {string} fallback Message to use when the payload carries none.
 * @returns {string} A message safe to display.
 */
export function errorMessage(payload, fallback) {
  return payload?.message ?? fallback;
}

/**
 * Read the per-field messages from a rejected thunk's payload.
 *
 * @param {*} payload The rejection payload.
 * @returns {Object<string, string>} Field name to message.
 */
export function errorFields(payload) {
  return payload?.fields ?? {};
}

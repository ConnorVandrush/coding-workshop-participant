/**
 * Shared shape for rejected thunks.
 *
 * Thunks used to reject with a bare string, which was enough for a toast but
 * discarded the per-field detail the API sends with a validation failure.
 * Rejecting with `{message, fields}` keeps both: the message for the toast, and
 * the field map so a form can put each message beside the input it refers to.
 */

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

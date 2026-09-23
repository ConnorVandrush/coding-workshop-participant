/**
 * The shape of an equipment draft, and the conversions around it.
 *
 * Kept out of `EquipmentDialog.jsx` so that file exports a component and
 * nothing else, which is what React Fast Refresh needs to reload it cleanly.
 */

/** An empty draft, also the shape every field in the dialog expects. */
export const EMPTY_EQUIPMENT = {
  code: '',
  name: '',
  asset_type: '',
  manufacturer: '',
  model: '',
  building_id: '',
  floor_id: '',
  seat_id: '',
  installed_on: '',
  expected_life_months: '',
  service_interval_months: '',
  last_serviced_on: '',
};

/**
 * Turn free text into the stored shape of an equipment class.
 *
 * Typed as "air handling unit" and stored as `AIR_HANDLING_UNIT`, so that two
 * people typing the same words land on the same class and the reliability
 * figures group them together instead of splitting.
 *
 * @param {string} value Whatever was typed.
 * @returns {string} The normalised class.
 */
export const normaliseType = (value) => value.trim().toUpperCase().replace(/\s+/g, '_');

/**
 * Convert a draft into the API payload, nulling the fields left blank.
 *
 * @param {object} draft The dialog's draft state.
 * @returns {object} The request body.
 */
export function equipmentPayload(draft) {
  const number = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    asset_type: normaliseType(draft.asset_type),
    manufacturer: draft.manufacturer.trim() || null,
    model: draft.model.trim() || null,
    building_id: number(draft.building_id),
    floor_id: number(draft.floor_id),
    seat_id: number(draft.seat_id),
    installed_on: draft.installed_on || null,
    expected_life_months: number(draft.expected_life_months),
    service_interval_months: number(draft.service_interval_months),
    last_serviced_on: draft.last_serviced_on || null,
  };
}

/**
 * Describe when a unit is next due a service, in words.
 *
 * @param {object} asset An asset carrying `service_status` and `days_until_service`.
 * @returns {string} For example `Overdue by 41 days`, or `Not scheduled`.
 */
export function serviceLabel(asset) {
  const days = asset?.days_until_service;
  switch (asset?.service_status) {
    case 'overdue':
      return `Overdue by ${Math.abs(days)} days`;
    case 'due_soon':
      return days === 0 ? 'Due today' : `Due in ${days} days`;
    case 'ok':
      return `Due in ${days} days`;
    default:
      return 'Not scheduled';
  }
}

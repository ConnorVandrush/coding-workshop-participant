/**
 * Material UI theme and the shared vocabulary for incident status and priority.
 *
 * Status and priority colours are defined once here so the chips, the
 * dashboard breakdowns and the workflow diagram all agree.
 */

import { createTheme } from '@mui/material/styles';

/** Display labels and colours for each incident status. */
export const STATUS_META = {
  OPEN: { label: 'Open', color: 'info' },
  IN_PROGRESS: { label: 'In Progress', color: 'primary' },
  BLOCKED: { label: 'Blocked', color: 'warning' },
  RESOLVED: { label: 'Resolved', color: 'success' },
  CLOSED: { label: 'Closed', color: 'default' },
};

/** Display labels and colours for each priority. */
export const PRIORITY_META = {
  LOW: { label: 'Low', color: 'default' },
  MEDIUM: { label: 'Medium', color: 'info' },
  HIGH: { label: 'High', color: 'warning' },
  CRITICAL: { label: 'Critical', color: 'error' },
};

/** The incident categories the API accepts, in menu order. */
export const CATEGORIES = [
  'HVAC',
  'ELECTRICAL',
  'PLUMBING',
  'FURNITURE',
  'CLEANING',
  'SECURITY',
  'NETWORK',
  'HARDWARE',
  'SOFTWARE',
  'AV_EQUIPMENT',
  'OTHER',
];

/** Human-readable role names. */
export const ROLE_LABELS = {
  employee: 'Employee',
  engineer: 'Engineer',
  facility_admin: 'Facility Admin',
};

/**
 * Turn an API enum value into a readable label.
 *
 * @param {string} value An upper snake-case value such as `AV_EQUIPMENT`.
 * @returns {string} A title-cased label such as `Av Equipment`.
 */
export function humanise(value) {
  if (!value) return '';
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format an ISO timestamp for display, tolerating nulls.
 *
 * @param {string|null} iso An ISO-8601 timestamp.
 * @returns {string} A locale date-time string, or an em dash when absent.
 */
export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

const theme = createTheme({
  palette: {
    primary: { main: '#1a4f8a' },
    secondary: { main: '#c2571a' },
    // MUI's stock info (#0288d1) and warning (#ed6c02) are only 3.9:1 and 3.1:1
    // against white, so every status and priority chip using them failed WCAG
    // AA in both directions - dark text on white, and white text on the filled
    // chip. These are the nearest shades that clear 4.5:1 (4.80 and 5.05), so
    // the palette still reads as the same blue and orange. The stock success
    // (5.13) and error (4.98) already pass and are left alone.
    info: { main: '#0277bd' },
    warning: { main: '#b35309' },
    // Stock text.disabled is rgba(0,0,0,0.38), which renders as #9b9b9b at
    // 2.8:1. It is used here for statuses a workflow has not reached yet -
    // ordinary informational text, not a disabled control, so the exemption
    // that WCAG grants disabled elements does not apply to it.
    text: { disabled: '#6e6e6e' },
    background: { default: '#f4f6f9' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    h1: { fontSize: '1.9rem', fontWeight: 700 },
    h2: { fontSize: '1.4rem', fontWeight: 700 },
    h3: { fontSize: '1.1rem', fontWeight: 600 },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiSelect: { defaultProps: { size: 'small' } },
  },
});

export default theme;

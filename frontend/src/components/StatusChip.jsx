/**
 * Chips for incident status and priority, plus an escalation marker.
 *
 * These are separate tiny components rather than one generic chip because each
 * maps a different vocabulary onto colour, and they appear side by side.
 */

import Chip from '@mui/material/Chip';
import PriorityHighIcon from '@mui/icons-material/PriorityHigh';
import PropTypes from 'prop-types';
import { PRIORITY_META, STATUS_META } from '../theme';

/**
 * Render an incident status as a coloured chip.
 *
 * @param {object} props Component props.
 * @param {string} props.status One of OPEN, IN_PROGRESS, BLOCKED, RESOLVED, CLOSED.
 * @param {string} [props.size] MUI chip size.
 * @returns {JSX.Element} The status chip.
 */
export function StatusChip({ status, size = 'small' }) {
  const meta = STATUS_META[status] ?? { label: status, color: 'default' };
  return <Chip label={meta.label} color={meta.color} size={size} variant="filled" />;
}

StatusChip.propTypes = {
  status: PropTypes.string.isRequired,
  size: PropTypes.oneOf(['small', 'medium']),
};


/**
 * Render an incident priority as a coloured chip.
 *
 * @param {object} props Component props.
 * @param {string} props.priority One of LOW, MEDIUM, HIGH, CRITICAL.
 * @param {string} [props.size] MUI chip size.
 * @returns {JSX.Element} The priority chip.
 */
export function PriorityChip({ priority, size = 'small' }) {
  const meta = PRIORITY_META[priority] ?? { label: priority, color: 'default' };
  return <Chip label={meta.label} color={meta.color} size={size} variant="outlined" />;
}

PriorityChip.propTypes = {
  priority: PropTypes.string.isRequired,
  size: PropTypes.oneOf(['small', 'medium']),
};


/**
 * Render an escalation marker, or nothing when the incident is not escalated.
 *
 * @param {object} props Component props.
 * @param {boolean} props.escalated Whether the incident is escalated.
 * @returns {JSX.Element|null} The chip, or null.
 */
export function EscalationChip({ escalated = false }) {
  if (!escalated) return null;
  return <Chip icon={<PriorityHighIcon />} label="Escalated" color="error" size="small" />;
}

EscalationChip.propTypes = { escalated: PropTypes.bool };

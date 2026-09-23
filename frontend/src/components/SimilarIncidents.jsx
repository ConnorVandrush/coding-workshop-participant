/**
 * The "is this already reported?" panel.
 *
 * Used in two places with the same shape of data: inside the report dialog,
 * where it asks the reporter to check before filing a thirteenth ticket for one
 * broken air conditioner, and on the detail page, where it lets a triager see
 * that three tickets are one fault.
 *
 * The panel never blocks anything. A duplicate prompt that stands between
 * someone and reporting a real problem is worse than the duplicates it
 * prevents, so the reporter can always ignore it and submit.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import PropTypes from 'prop-types';
import { Link as RouterLink } from 'react-router-dom';
import { PriorityChip, StatusChip } from './StatusChip';
import { formatDateTime, humanise } from '../theme';

/**
 * Describe where an incident is, in as few words as the data allows.
 *
 * @param {object} location The match's location block.
 * @returns {string} A human-readable place, or an empty string when unknown.
 */
function placeOf(location) {
  if (!location) return '';
  const parts = [];
  if (location.building_name) parts.push(location.building_name);
  if (location.floor_level !== null && location.floor_level !== undefined) {
    parts.push(`level ${location.floor_level}`);
  }
  if (location.seat_code) parts.push(location.seat_code);
  return parts.join(' · ');
}

/**
 * Render one candidate duplicate.
 *
 * @param {object} props Component props.
 * @param {object} props.match A match from the duplicate-check API.
 * @returns {JSX.Element} The list row.
 */
function Match({ match }) {
  const place = placeOf(match.location);
  // `visible` says whether this caller may open the full record. An employee
  // sees that a colleague already reported the fault, but following the link
  // would 404, so it is rendered as plain text instead of a dead link.
  const heading = match.visible ? (
    <Link component={RouterLink} to={`/incidents/${match.id}`} underline="hover">
      #{match.id} {match.title}
    </Link>
  ) : (
    <Typography component="span" sx={{ fontWeight: 500 }}>
      #{match.id} {match.title}
    </Typography>
  );

  return (
    <ListItem disableGutters sx={{ display: 'block', py: 1 }}>
      <Stack
        direction="row"
        sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}
      >
        {heading}
        <StatusChip status={match.status} />
        <PriorityChip priority={match.priority} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {humanise(match.category)}
        {place ? ` · ${place}` : ''} · reported {formatDateTime(match.created_at)}
      </Typography>
      {match.reasons.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          Matched because: {match.reasons.join(', ')}
        </Typography>
      )}
      {!match.visible && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          Reported by someone else, so you cannot open it.
        </Typography>
      )}
    </ListItem>
  );
}

Match.propTypes = {
  match: PropTypes.shape({
    id: PropTypes.number.isRequired,
    title: PropTypes.string.isRequired,
    category: PropTypes.string.isRequired,
    priority: PropTypes.string.isRequired,
    status: PropTypes.string.isRequired,
    created_at: PropTypes.string.isRequired,
    reasons: PropTypes.arrayOf(PropTypes.string).isRequired,
    visible: PropTypes.bool.isRequired,
    location: PropTypes.object,
  }).isRequired,
};

/**
 * Render the panel of possible duplicates, or nothing when there are none.
 *
 * @param {object} props Component props.
 * @param {Array} props.matches Matches from the API, best first.
 * @param {string} [props.variant] `draft` inside the report dialog, `detail` elsewhere.
 * @returns {JSX.Element|null} The panel, or null when there is nothing to say.
 */
export default function SimilarIncidents({ matches, variant = 'draft' }) {
  if (!matches || matches.length === 0) return null;

  const isDraft = variant === 'draft';
  const count = matches.length;
  const title = isDraft
    ? `This may already be reported (${count} similar ${count === 1 ? 'incident' : 'incidents'})`
    : `${count} similar ${count === 1 ? 'incident' : 'incidents'}`;

  return (
    <Alert
      severity={isDraft ? 'warning' : 'info'}
      // Announced politely rather than assertively: the panel appears while the
      // reporter is typing, and an assertive live region would interrupt a
      // screen reader mid-word on every keystroke that changes the results.
      role="status"
      aria-live="polite"
      data-testid="similar-incidents"
    >
      <AlertTitle>{title}</AlertTitle>
      {isDraft && (
        <Typography variant="body2">
          Check whether one of these is your problem. If it is, there is no need to report it
          again — you can still report yours if it is different.
        </Typography>
      )}
      <Box component={List} dense disablePadding sx={{ mt: isDraft ? 1 : 0 }}>
        {matches.map((match) => (
          <Match key={match.id} match={match} />
        ))}
      </Box>
    </Alert>
  );
}

SimilarIncidents.propTypes = {
  matches: PropTypes.arrayOf(PropTypes.object),
  variant: PropTypes.oneOf(['draft', 'detail']),
};

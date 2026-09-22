/**
 * Shows that a page keeps itself up to date, and offers a manual refresh.
 *
 * Without this the polling is invisible, and a user cannot tell whether the
 * figures they are looking at are current or stale.
 */

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import PropTypes from 'prop-types';
import { POLL_INTERVAL_MS } from '../hooks/usePolling';

/**
 * Describe how long ago something happened, in words.
 *
 * @param {number} seconds Seconds elapsed.
 * @returns {string} A short phrase such as `just now` or `3 min ago`.
 */
function describeAge(seconds) {
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

/**
 * Render the freshness indicator.
 *
 * @param {object} props Component props.
 * @param {boolean} props.loading Whether a refresh is in flight.
 * @param {Function} props.onRefresh Called when the user refreshes manually.
 * @param {string} [props.label] What is being kept fresh, for the tooltip.
 * @returns {JSX.Element} The indicator.
 */
export default function LiveStatus({ loading, onRefresh, updatedAt = null, label = 'data' }) {
  // The current time is held in state and advanced by the timer, so rendering
  // stays a pure function of props and state rather than reading the clock.
  const [now, setNow] = useState(0);

  useEffect(() => {
    // Only the timer advances the clock; until its first tick `now` is 0 and
    // the age reads as "just now", which is true for a freshly mounted page.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const age = updatedAt && now ? Math.floor((now - updatedAt) / 1000) : null;

  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      <Box
        aria-hidden
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: loading ? 'warning.main' : 'success.main',
          transition: 'background-color 200ms',
        }}
      />
      <Typography variant="caption" color="text.secondary" aria-live="polite">
        {loading ? 'Refreshing…' : `Updated ${age === null ? 'just now' : describeAge(age)}`}
      </Typography>
      <Tooltip title={`Refresh ${label} now (auto every ${Math.round(POLL_INTERVAL_MS / 1000)}s)`}>
        <span>
          <IconButton size="small" onClick={onRefresh} disabled={loading} aria-label={`Refresh ${label}`}>
            {loading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

LiveStatus.propTypes = {
  loading: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  updatedAt: PropTypes.number,
  label: PropTypes.string,
};

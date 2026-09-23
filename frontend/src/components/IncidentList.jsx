/**
 * Incident list, rendered as a table on desktop and as cards on small screens.
 *
 * A data table is unusable at phone width, so React Responsive picks the
 * presentation rather than CSS hiding columns — both variants show the same
 * fields, arranged for the space available.
 */

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import PropTypes from 'prop-types';
import { useMediaQuery } from 'react-responsive';
import { EscalationChip, PriorityChip, StatusChip } from './StatusChip';
import { formatDateTime, humanise } from '../theme';

/**
 * Build a one-line location label from an incident's location block.
 *
 * @param {object} location The incident's `location` object.
 * @returns {string} A readable location, or an em dash when unknown.
 */
function locationLabel(location) {
  if (!location?.building_name) return '—';
  const parts = [location.building_name];
  if (location.floor_level !== null && location.floor_level !== undefined) {
    parts.push(`L${location.floor_level}`);
  }
  if (location.seat_code) parts.push(location.seat_code);
  return parts.join(' · ');
}

/**
 * Render the incident list.
 *
 * @param {object} props Component props.
 * @param {Array} props.incidents Incidents to display.
 * @param {Function} props.onSelect Called with an incident id when one is opened.
 * @returns {JSX.Element} The list.
 */
export default function IncidentList({ incidents, onSelect }) {
  const isDesktop = useMediaQuery({ minWidth: 900 });

  if (incidents.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">
          No incidents match these filters.
        </Typography>
      </Paper>
    );
  }

  if (!isDesktop) {
    return (
      <Stack spacing={1.5}>
        {incidents.map((incident) => (
          <Card key={incident.id} variant="outlined">
            <CardActionArea onClick={() => onSelect(incident.id)}>
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
                  <StatusChip status={incident.status} />
                  <PriorityChip priority={incident.priority} />
                  <EscalationChip escalated={incident.is_escalated} />
                </Stack>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  #{incident.id} · {incident.title}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {humanise(incident.category)} · {locationLabel(incident.location)}
                </Typography>
                {incident.asset ? (
                  <Typography variant="body2" color="text.secondary">
                    {incident.asset.code} — {incident.asset.name}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {incident.assignee ? `Assigned to ${incident.assignee.full_name}` : 'Unassigned'}
                  {' · '}
                  {formatDateTime(incident.created_at)}
                </Typography>
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Stack>
    );
  }

  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            <TableCell>Title</TableCell>
            <TableCell>Category</TableCell>
            <TableCell>Location</TableCell>
            <TableCell>Equipment</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Priority</TableCell>
            <TableCell>Assignee</TableCell>
            <TableCell>Reported</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {incidents.map((incident) => (
            <TableRow
              key={incident.id}
              hover
              onClick={() => onSelect(incident.id)}
              sx={{ cursor: 'pointer' }}
            >
              <TableCell>{incident.id}</TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {incident.title}
                  </Typography>
                  <EscalationChip escalated={incident.is_escalated} />
                </Box>
              </TableCell>
              <TableCell>{humanise(incident.category)}</TableCell>
              <TableCell>{locationLabel(incident.location)}</TableCell>
              <TableCell>
                {incident.asset ? (
                  // The tag alone: the full name is on the detail view, and a
                  // second long string here pushes the workflow columns off a
                  // laptop screen.
                  <Typography variant="body2" noWrap title={incident.asset.name}>
                    {incident.asset.code}
                  </Typography>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>
                <StatusChip status={incident.status} />
              </TableCell>
              <TableCell>
                <PriorityChip priority={incident.priority} />
              </TableCell>
              <TableCell>{incident.assignee?.full_name ?? '—'}</TableCell>
              <TableCell>{formatDateTime(incident.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

IncidentList.propTypes = {
  incidents: PropTypes.arrayOf(PropTypes.object).isRequired,
  onSelect: PropTypes.func.isRequired,
};

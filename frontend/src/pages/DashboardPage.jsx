/**
 * Role-aware dashboard.
 *
 * The same panels render for every persona because the API already scopes the
 * numbers: an employee sees their own tickets, an engineer sees their queue,
 * and a facility admin sees the estate. Only the engineer workload table is
 * admin-only, because it is management information.
 */

import { useCallback, useEffect } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import CardContent from '@mui/material/CardContent';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import PropTypes from 'prop-types';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import LiveStatus from '../components/LiveStatus';
import WorkflowDiagram from '../components/WorkflowDiagram';
import usePolling from '../hooks/usePolling';
import {
  fetchDashboard,
  fetchWorkflow,
  selectHotspots,
  selectSla,
  selectSummary,
  selectWorkflow,
  selectWorkload,
  selectDashboardUpdatedAt,
} from '../store/dashboardSlice';
import { selectUser } from '../store/authSlice';
import { setFilters } from '../store/incidentsSlice';
import { ROLE_LABELS, humanise } from '../theme';

/**
 * A single headline number.
 *
 * @param {object} props Component props.
 * @param {string} props.label What the number counts.
 * @param {number|string} props.value The number itself.
 * @param {string} [props.color] MUI palette colour for the value.
 * @param {Function} [props.onClick] Makes the tile a drill-down when supplied.
 * @returns {JSX.Element} The stat tile.
 */
function StatTile({ label, value, color = 'text.primary', onClick }) {
  return (
    <Card
      variant="outlined"
      onClick={onClick}
      sx={{ height: '100%', cursor: onClick ? 'pointer' : 'default' }}
    >
      <CardContent>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase' }}>
          {label}
        </Typography>
        <Typography variant="h1" sx={{ color, mt: 0.5 }}>
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}

StatTile.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
  color: PropTypes.string,
  onClick: PropTypes.func,
};

/**
 * A labelled count breakdown with proportional bars.
 *
 * @param {object} props Component props.
 * @param {string} props.title Panel heading.
 * @param {Array} props.buckets `{key, count}` rows.
 * @param {Function} [props.onSelect] Called with a bucket key to drill down.
 * @returns {JSX.Element} The breakdown panel.
 */
function Breakdown({ title, buckets, onSelect }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return (
    <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
      <Typography variant="h3" gutterBottom>
        {title}
      </Typography>
      {buckets.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing recorded yet.
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {buckets.map((bucket) => (
            <Box
              key={bucket.key}
              onClick={onSelect ? () => onSelect(bucket.key) : undefined}
              sx={{ cursor: onSelect ? 'pointer' : 'default' }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="body2">{humanise(bucket.key)}</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {bucket.count}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={(bucket.count / max) * 100}
                sx={{ height: 6, borderRadius: 3 }}
              />
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

Breakdown.propTypes = {
  title: PropTypes.string.isRequired,
  buckets: PropTypes.arrayOf(PropTypes.object).isRequired,
  onSelect: PropTypes.func,
};

/**
 * Render the dashboard.
 *
 * @returns {JSX.Element} The dashboard page.
 */
export default function DashboardPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const user = useSelector(selectUser);
  const summary = useSelector(selectSummary);
  const hotspots = useSelector(selectHotspots);
  const sla = useSelector(selectSla);
  const workload = useSelector(selectWorkload);
  const workflow = useSelector(selectWorkflow);
  const updatedAt = useSelector(selectDashboardUpdatedAt);
  const { status, error } = useSelector((state) => state.dashboard);

  useEffect(() => {
    dispatch(fetchDashboard());
    dispatch(fetchWorkflow());
  }, [dispatch]);

  // The workflow graph is static, so only the figures are refreshed.
  const refresh = useCallback(() => dispatch(fetchDashboard()), [dispatch]);
  usePolling(refresh);

  /**
   * Jump to the incident list pre-filtered.
   *
   * @param {object} filters Filter values to apply.
   */
  const drillDown = (filters) => {
    dispatch(setFilters(filters));
    navigate('/incidents');
  };

  if (status === 'loading' && !summary) return <LinearProgress sx={{ mt: 2 }} />;
  if (error) return <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>;
  if (!summary) return null;

  const isAdmin = user?.role === 'facility_admin';

  return (
    <Box sx={{ py: 3 }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <Typography variant="h1" gutterBottom>
          {ROLE_LABELS[summary.scope] ?? 'Dashboard'} overview
        </Typography>
        <LiveStatus
          loading={status === 'loading'}
          updatedAt={updatedAt}
          onRefresh={refresh}
          label="dashboard"
        />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        {isAdmin
          ? 'Every incident across the estate.'
          : summary.scope === 'engineer'
            ? 'Incidents assigned to you, plus anything still unassigned.'
            : 'Incidents you have reported.'}
      </Typography>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile label="Total" value={summary.total} onClick={() => drillDown({ status: '' })} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile
            label="Still active"
            value={summary.open_total}
            color="info.main"
            onClick={() => drillDown({ status: 'OPEN' })}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile
            label="Escalated"
            value={summary.escalated_total}
            color="error.main"
            onClick={() => drillDown({ is_escalated: 'true', unassigned: '' })}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatTile
            label="Unassigned"
            value={summary.unassigned_total}
            color="warning.main"
            onClick={() => drillDown({ unassigned: 'true', is_escalated: '' })}
          />
        </Grid>
      </Grid>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Breakdown
            title="By status"
            buckets={summary.by_status}
            onSelect={(key) => drillDown({ status: key })}
          />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Breakdown
            title="By priority"
            buckets={summary.by_priority}
            onSelect={(key) => drillDown({ priority: key })}
          />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Breakdown
            title="By category"
            buckets={summary.by_category}
            onSelect={(key) => drillDown({ category: key })}
          />
        </Grid>
      </Grid>

      <Box sx={{ mb: 3 }}>
        <WorkflowDiagram workflow={workflow} />
      </Box>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
            <Typography variant="h3" gutterBottom>
              Recurring issue hotspots
            </Typography>
            <Grid container spacing={2}>
              {[
                ['Buildings', hotspots?.buildings ?? []],
                ['Floors', hotspots?.floors ?? []],
                ['Seats', hotspots?.seats ?? []],
              ].map(([label, rows]) => (
                <Grid size={{ xs: 12, sm: 4 }} key={label}>
                  <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase' }}>
                    {label}
                  </Typography>
                  {rows.length === 0 ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      —
                    </Typography>
                  ) : (
                    <Stack spacing={0.5} sx={{ mt: 1 }}>
                      {rows.map((row) => (
                        <Box key={`${label}-${row.id}`} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          {/* Seat labels are long; truncate but expose the
                              full text natively on hover and to screen readers. */}
                          <Typography variant="body2" noWrap title={row.label} sx={{ mr: 1 }}>
                            {row.label}
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {row.count}
                            <Typography variant="caption" component="span" color="text.secondary">
                              {` (${row.open_count} open)`}
                            </Typography>
                          </Typography>
                        </Box>
                      ))}
                    </Stack>
                  )}
                </Grid>
              ))}
            </Grid>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
            <Typography variant="h3" gutterBottom>
              Response times
            </Typography>
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {[
                ['Acknowledged', sla?.acknowledged_hours_avg],
                ['Assigned', sla?.assigned_hours_avg],
                ['Resolved', sla?.resolved_hours_avg],
                ['Closed', sla?.closed_hours_avg],
              ].map(([label, hours]) => (
                <Box key={label} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">{label}</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {hours === null || hours === undefined ? '—' : `${hours} h avg`}
                  </Typography>
                </Box>
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
              {sla?.resolved_count ?? 0} resolved of {sla?.sample_size ?? 0} incidents.
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {isAdmin && workload.length > 0 ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h3" gutterBottom>
            Work distribution
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Engineer</TableCell>
                <TableCell align="right">Active</TableCell>
                <TableCell align="right">Capacity</TableCell>
                <TableCell align="right">Resolved</TableCell>
                <TableCell align="right">Closed</TableCell>
                <TableCell align="right">Escalated</TableCell>
                <TableCell>Availability</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {workload.map((row) => (
                <TableRow key={row.engineer_id} hover>
                  <TableCell>{row.full_name}</TableCell>
                  <TableCell align="right">{row.active}</TableCell>
                  <TableCell align="right">{row.max_active_incidents}</TableCell>
                  <TableCell align="right">{row.resolved}</TableCell>
                  <TableCell align="right">{row.closed}</TableCell>
                  <TableCell align="right">{row.escalated}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={row.is_available ? 'Available' : 'Unavailable'}
                      color={row.is_available ? 'success' : 'default'}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      ) : null}
    </Box>
  );
}

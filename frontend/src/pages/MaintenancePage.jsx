/**
 * Maintenance: which equipment is worth replacing rather than repairing.
 *
 * Staff only. Everything here is counting, and the counting is shown: every
 * flagged unit carries the sentences that flagged it, because this screen is
 * used to argue for spending money and "the system says so" is not an argument.
 *
 * The coverage figure leads deliberately. Each per-unit number below it is
 * computed only from incidents that named a unit, so a low coverage makes the
 * rest of the screen a sample rather than a census, and the reader should know
 * that before they read on.
 */

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import PropTypes from 'prop-types';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import EquipmentDialog from '../components/EquipmentDialog';
import { EMPTY_EQUIPMENT, equipmentPayload } from '../components/equipmentDraft';
import { selectUser } from '../store/authSlice';
import { setFilters } from '../store/incidentsSlice';
import {
  DEFAULT_WINDOW_DAYS,
  createAsset,
  fetchMaintenance,
  selectAssetReview,
  selectMaintenanceHotspots,
  selectMaintenanceSummary,
  selectTypeReliability,
  setWindowDays,
} from '../store/maintenanceSlice';
import { fetchBuildings, fetchFloors, selectBuildings, selectFloors } from '../store/facilitiesSlice';
import { notify } from '../store/uiSlice';
import { errorFields, errorMessage } from '../store/thunkUtils';
import { humanise } from '../theme';

// Offered windows. Anything shorter than a month flags units on coincidence;
// anything longer stops being news.
// Returned by the seat selector when nothing is loaded yet. A literal `[]`
// there is a new reference on every call, which re-renders the page on any
// store change and makes React Redux warn about it.
const NO_SEATS = [];

const WINDOWS = [
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 180, label: 'Last 6 months' },
  { value: 365, label: 'Last year' },
];

/**
 * A single headline figure.
 *
 * @param {object} props Component props.
 * @param {string} props.label Caption above the number.
 * @param {number|string} props.value The figure itself.
 * @param {string} [props.hint] Secondary line under the number.
 * @param {string} [props.color] Theme colour for the number.
 * @returns {JSX.Element} The tile.
 */
function StatTile({ label, value, hint, color = 'text.primary' }) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase' }}>
          {label}
        </Typography>
        <Typography variant="h1" sx={{ color, mt: 0.5 }}>
          {value}
        </Typography>
        {hint ? (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

StatTile.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
  hint: PropTypes.string,
  color: PropTypes.string,
};

/**
 * Render the maintenance page.
 *
 * @returns {JSX.Element} The maintenance page.
 */
export default function MaintenancePage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const user = useSelector(selectUser);
  const summary = useSelector(selectMaintenanceSummary);
  const review = useSelector(selectAssetReview);
  const types = useSelector(selectTypeReliability);
  const hotspots = useSelector(selectMaintenanceHotspots);
  const buildings = useSelector(selectBuildings);
  const floors = useSelector(selectFloors);
  const { windowDays, status, error, saving } = useSelector((state) => state.maintenance);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_EQUIPMENT);
  const [fieldErrors, setFieldErrors] = useState({});

  const isAdmin = user?.role === 'facility_admin';
  const seats = useSelector((state) => state.facilities.seatsByFloor[draft.floor_id] ?? NO_SEATS);

  useEffect(() => {
    dispatch(fetchMaintenance(windowDays));
  }, [dispatch, windowDays]);

  useEffect(() => {
    if (dialogOpen) dispatch(fetchBuildings());
  }, [dispatch, dialogOpen]);

  useEffect(() => {
    if (draft.building_id) dispatch(fetchFloors(draft.building_id));
  }, [dispatch, draft.building_id]);

  /**
   * Report the outcome of a dispatched thunk as a toast.
   *
   * @param {object} result The dispatch result.
   * @param {string} successMessage Message shown when the call succeeded.
   * @returns {boolean} Whether the call succeeded.
   */
  const report = (result, successMessage) => {
    const ok = result.meta.requestStatus === 'fulfilled';
    setFieldErrors(ok ? {} : errorFields(result.payload));
    dispatch(
      notify({
        message: ok ? successMessage : errorMessage(result.payload, 'The request failed'),
        severity: ok ? 'success' : 'error',
      }),
    );
    return ok;
  };

  /** Reload the figures. */
  const refresh = () => dispatch(fetchMaintenance(windowDays));

  /** Register the drafted unit. */
  const addAsset = async () => {
    const result = await dispatch(createAsset(equipmentPayload(draft)));
    if (report(result, 'Equipment registered')) {
      setDraft(EMPTY_EQUIPMENT);
      setDialogOpen(false);
      refresh();
    }
  };

  /**
   * Show every incident raised against one unit.
   *
   * @param {number} assetId The unit to filter by.
   */
  const showIncidents = (assetId) => {
    dispatch(setFilters({ asset_id: assetId }));
    navigate('/incidents');
  };

  if (status === 'failed') {
    return (
      <Box sx={{ py: 3 }}>
        <Alert severity="error">
          {errorMessage(error, 'The maintenance figures could not be loaded')}
        </Alert>
      </Box>
    );
  }

  const coverage = summary?.linked_percent ?? 0;
  const flagged = (review?.items ?? []).filter((item) => item.needs_review);

  return (
    <Box sx={{ py: 3 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 3 }}
        spacing={1}
      >
        <Box>
          <Typography variant="h1">Maintenance</Typography>
          <Typography variant="body2" color="text.secondary">
            Which units keep failing, and which classes of equipment keep failing everywhere.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <TextField
            select
            size="small"
            label="Window"
            value={windowDays}
            onChange={(event) => dispatch(setWindowDays(Number(event.target.value)))}
            sx={{ minWidth: 160 }}
          >
            {WINDOWS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          {isAdmin ? (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
              Register equipment
            </Button>
          ) : null}
        </Stack>
      </Stack>

      {status === 'loading' && !summary ? (
        <LinearProgress aria-label="Loading the maintenance figures" sx={{ mb: 2 }} />
      ) : null}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 6, md: 2 }}>
          <StatTile label="Units" value={summary?.assets_tracked ?? 0} hint={`${summary?.assets_retired ?? 0} retired`} />
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <StatTile
            label="Needing review"
            value={summary?.assets_needing_review ?? 0}
            color={summary?.assets_needing_review ? 'error.main' : 'text.primary'}
            hint="Flagged by the rules below"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <StatTile
            label="Service overdue"
            value={summary?.assets_service_overdue ?? 0}
            color={summary?.assets_service_overdue ? 'error.main' : 'text.primary'}
            hint="Past their service date"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <StatTile
            label="Due soon"
            value={summary?.assets_service_due_soon ?? 0}
            color={summary?.assets_service_due_soon ? 'warning.main' : 'text.primary'}
            hint="Service within 30 days"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <StatTile
            label="Past life"
            value={summary?.assets_past_expected_life ?? 0}
            hint="Older than expected"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <StatTile
            label="Linked"
            value={`${coverage}%`}
            color={coverage < 50 ? 'warning.main' : 'text.primary'}
            hint={`${summary?.incidents_linked ?? 0} of ${summary?.incidents_total ?? 0} name a unit`}
          />
        </Grid>
      </Grid>

      {summary && coverage < 50 ? (
        <Alert severity="warning" sx={{ mb: 3 }}>
          Fewer than half of all incidents name a unit of equipment, so the figures below describe
          only the part of the record that does. Attributing incidents to equipment as they are
          reported is what makes the rest of this page trustworthy.
        </Alert>
      ) : null}

      {summary?.assets_without_service_interval ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          {summary.assets_without_service_interval} unit
          {summary.assets_without_service_interval === 1 ? ' has' : 's have'} no service interval set, so
          nothing can fall due for them. Setting one is what turns this screen from a record of what has
          already broken into a plan for what has not.
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="h3" gutterBottom>
          Units to review
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Counting, not prediction: a unit is listed when it fails repeatedly, fails more often than
          others of its type, or has outlived its expected service life. The reason is always shown.
        </Typography>
        {flagged.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No unit meets any of the review rules over this window.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Units to review">
              <TableHead>
                <TableRow>
                  <TableCell>Unit</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell align="right">Failures</TableCell>
                  <TableCell align="right">In window</TableCell>
                  <TableCell align="right">Age</TableCell>
                  <TableCell>Why</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {flagged.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {item.code}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.name} · {humanise(item.asset_type)}
                      </Typography>
                    </TableCell>
                    <TableCell>{item.location}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => showIncidents(item.id)}>
                        {item.incident_count}
                      </Button>
                    </TableCell>
                    <TableCell align="right">{item.recent_incident_count}</TableCell>
                    <TableCell align="right">
                      {item.age_years === null ? '—' : `${item.age_years}y`}
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        {item.reasons.map((reason) => (
                          <Chip key={reason} label={reason} size="small" color="warning" variant="outlined" />
                        ))}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
            <Typography variant="h3" gutterBottom>
              Reliability by equipment class
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              A class averaging several failures per unit is a purchasing decision, not a repair one.
            </Typography>
            {types.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nothing registered yet.
              </Typography>
            ) : (
              <TableContainer>
                <Table size="small" aria-label="Reliability by equipment class">
                  <TableHead>
                    <TableRow>
                      <TableCell>Class</TableCell>
                      <TableCell align="right">Units</TableCell>
                      <TableCell align="right">Failures</TableCell>
                      <TableCell align="right">Per unit</TableCell>
                      <TableCell align="right">Avg age</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {types.map((row) => (
                      <TableRow key={row.asset_type} hover>
                        <TableCell>{humanise(row.asset_type)}</TableCell>
                        <TableCell align="right">{row.asset_count}</TableCell>
                        <TableCell align="right">{row.incident_count}</TableCell>
                        <TableCell align="right">{row.incidents_per_asset}</TableCell>
                        <TableCell align="right">
                          {row.avg_age_years === null ? '—' : `${row.avg_age_years}y`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper
            variant="outlined"
            component="section"
            role="region"
            aria-label="Recurring issue hotspots"
            sx={{ p: 2, height: '100%' }}
          >
            <Typography variant="h3" gutterBottom>
              Recurring issue hotspots
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Where faults are reported. A quiet floor may have better equipment, or simply people
              who do not report, so read these alongside the per-unit figures rather than instead.
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
      </Grid>

      <EquipmentDialog
        open={dialogOpen}
        title="Register equipment"
        draft={draft}
        onChange={setDraft}
        onSubmit={addAsset}
        onClose={() => setDialogOpen(false)}
        fieldErrors={fieldErrors}
        saving={saving}
        buildings={buildings}
        floors={floors}
        seats={seats}
      />

    </Box>
  );
}

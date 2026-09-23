/**
 * Incident list with search, filtering, pagination and reporting.
 *
 * Any signed-in persona can report an incident; what the list contains is
 * decided by the API, which scopes rows to the caller's role.
 */

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Pagination from '@mui/material/Pagination';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import IncidentFilters from '../components/IncidentFilters';
import LiveStatus from '../components/LiveStatus';
import IncidentList from '../components/IncidentList';
import SimilarIncidents from '../components/SimilarIncidents';
import usePolling from '../hooks/usePolling';
import {
  fetchBuildings,
  fetchFloors,
  fetchSeats,
  selectBuildings,
  selectFloors,
} from '../store/facilitiesSlice';
import {
  checkDuplicates,
  clearDuplicates,
  createIncident,
  fetchIncidents,
  resetFilters,
  selectDuplicates,
  selectFilters,
  selectIncidents,
  setFilters,
  setPage,
} from '../store/incidentsSlice';
import { selectUser } from '../store/authSlice';
import { fetchAssets, selectAssets } from '../store/maintenanceSlice';
import { notify } from '../store/uiSlice';
import { errorFields, errorMessage } from '../store/thunkUtils';
import { CATEGORIES, PRIORITY_META, humanise } from '../theme';

// A title shorter than this is not worth searching on: it matches half the
// table and the suggestions flicker as the reporter types the first word.
const MIN_TITLE_FOR_LOOKUP = 8;

// Long enough to let someone finish a word, short enough that the answer is
// there by the time they look up from the keyboard.
const LOOKUP_DEBOUNCE_MS = 400;

const EMPTY_DRAFT = {
  title: '',
  description: '',
  category: 'OTHER',
  priority: 'MEDIUM',
  building_id: '',
  floor_id: '',
  seat_id: '',
  asset_id: '',
};

/**
 * Render the incident list page.
 *
 * @returns {JSX.Element} The incidents page.
 */
export default function IncidentsPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const user = useSelector(selectUser);
  const incidents = useSelector(selectIncidents);
  const filters = useSelector(selectFilters);
  const buildings = useSelector(selectBuildings);
  const floors = useSelector(selectFloors);
  const { total, page, pageSize, listStatus, listError, saving, listUpdatedAt } = useSelector(
    (state) => state.incidents,
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  // Per-field messages from a rejected submission.
  const [fieldErrors, setFieldErrors] = useState({});
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const seats = useSelector((state) => state.facilities.seatsByFloor[draft.floor_id] ?? []);
  const duplicates = useSelector(selectDuplicates);
  const assets = useSelector(selectAssets);

  // What the list is scoped to. An engineer meeting a row they are not
  // assigned to has nothing else on screen explaining why it is there.
  const scopeNote =
    user?.role === 'engineer'
      ? 'yours, plus other faults on equipment you are working on'
      : user?.role === 'employee'
        ? 'the ones you reported'
        : '';

  useEffect(() => {
    dispatch(fetchBuildings());
  }, [dispatch]);

  // Re-fetch whenever a filter or the page changes. The search box is included,
  // so typing narrows the list as the user goes.
  useEffect(() => {
    const timer = setTimeout(() => dispatch(fetchIncidents()), 250);
    return () => clearTimeout(timer);
  }, [dispatch, filters, page]);

  // Ask whether this has already been reported, as the reporter types.
  //
  // Debounced rather than fired per keystroke, and skipped entirely until the
  // title is long enough to mean something. The dialog's open state is in the
  // dependencies so closing it cancels a pending lookup.
  useEffect(() => {
    if (!dialogOpen || draft.title.trim().length < MIN_TITLE_FOR_LOOKUP) {
      dispatch(clearDuplicates());
      return undefined;
    }
    const payload = { title: draft.title.trim(), category: draft.category };
    if (draft.description.trim()) payload.description = draft.description.trim();
    if (draft.building_id) payload.building_id = Number(draft.building_id);
    if (draft.floor_id) payload.floor_id = Number(draft.floor_id);
    if (draft.seat_id) payload.seat_id = Number(draft.seat_id);

    const timer = setTimeout(() => dispatch(checkDuplicates(payload)), LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    dispatch,
    dialogOpen,
    draft.title,
    draft.description,
    draft.category,
    draft.building_id,
    draft.floor_id,
    draft.seat_id,
  ]);

  // Load the floors of whichever building the reporter picks in the dialog.
  useEffect(() => {
    if (draft.building_id) dispatch(fetchFloors(draft.building_id));
  }, [dispatch, draft.building_id]);

  // Offer the equipment at the location chosen so far, narrowing as the
  // reporter narrows. Asking "which unit?" against the whole estate would be a
  // list nobody reads; against one desk it is usually one or two things.
  useEffect(() => {
    if (!dialogOpen) return;
    dispatch(
      fetchAssets({
        building_id: draft.building_id || undefined,
        floor_id: draft.floor_id || undefined,
        seat_id: draft.seat_id || undefined,
        limit: 100,
      }),
    );
  }, [dispatch, dialogOpen, draft.building_id, draft.floor_id, draft.seat_id]);

  // ...and the seats of the chosen floor, so the reporter can pinpoint a desk.
  useEffect(() => {
    if (draft.floor_id) dispatch(fetchSeats(draft.floor_id));
  }, [dispatch, draft.floor_id]);

  /** Submit the report dialog. */
  const handleCreate = async () => {
    const payload = {
      title: draft.title,
      description: draft.description,
      category: draft.category,
      priority: draft.priority,
    };
    if (draft.building_id) payload.building_id = Number(draft.building_id);
    if (draft.floor_id) payload.floor_id = Number(draft.floor_id);
    if (draft.seat_id) payload.seat_id = Number(draft.seat_id);
    if (draft.asset_id) payload.asset_id = Number(draft.asset_id);

    const result = await dispatch(createIncident(payload));
    setFieldErrors(result.meta.requestStatus === 'fulfilled' ? {} : errorFields(result.payload));
    if (result.meta.requestStatus === 'fulfilled') {
      dispatch(notify({ message: `Incident #${result.payload.id} reported`, severity: 'success' }));
      setDialogOpen(false);
      setDraft(EMPTY_DRAFT);
      dispatch(fetchIncidents());
    } else {
      dispatch(notify({ message: errorMessage(result.payload, 'Could not report the incident'), severity: 'error' }));
    }
  };

  // Suspended while a report is being submitted, so a refresh cannot race it.
  const refresh = useCallback(() => dispatch(fetchIncidents()), [dispatch]);
  usePolling(refresh, { enabled: !dialogOpen && !saving });

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const canSubmit = draft.title.trim().length > 0 && draft.description.trim().length > 0;

  return (
    <Box sx={{ py: 3 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
       
       
        sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="h1">Incidents</Typography>
          <Typography variant="body2" color="text.secondary">
            {total} matching {total === 1 ? 'incident' : 'incidents'}
            {scopeNote ? ` · ${scopeNote}` : ''}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <LiveStatus
            loading={listStatus === 'loading'}
            updatedAt={listUpdatedAt}
            onRefresh={refresh}
            label="incidents"
          />
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
            Report incident
          </Button>
        </Stack>
      </Stack>

      <IncidentFilters
        filters={filters}
        buildings={buildings}
        onChange={(update) => dispatch(setFilters(update))}
        onReset={() => dispatch(resetFilters())}
      />

      {/* The filter bar has no control for equipment - the maintenance screen
          sets it on the way in. Without this the reader would be looking at a
          short list with nothing on screen explaining why. */}
      {filters.asset_id ? (
        <Chip
          sx={{ mb: 2 }}
          color="primary"
          variant="outlined"
          onDelete={() => dispatch(setFilters({ asset_id: '' }))}
          label={`Showing failures of ${
            incidents.find((incident) => incident.asset)?.asset?.code ?? 'one unit'
          }`}
        />
      ) : null}

      {listStatus === 'loading' ? <LinearProgress aria-label="Loading incidents" sx={{ mb: 2 }} /> : null}
      {listError ? <Alert severity="error" sx={{ mb: 2 }}>{listError}</Alert> : null}

      <IncidentList incidents={incidents} onSelect={(id) => navigate(`/incidents/${id}`)} />

      {pageCount > 1 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Pagination
            count={pageCount}
            page={page + 1}
            onChange={(_, value) => dispatch(setPage(value - 1))}
            color="primary"
          />
        </Box>
      ) : null}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Report an incident</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0 }}>
            <Grid size={12}>
              <TextField
                label="Title"
                fullWidth
                required
                disabled={saving}
                error={Boolean(fieldErrors.title)}
                helperText={fieldErrors.title ?? ' '}
                value={draft.title}
                onChange={(event) => {
                  setDraft({ ...draft, title: event.target.value });
                  setFieldErrors({});
                }}
              />
            </Grid>
            <Grid size={12}>
              <TextField
                label="What is wrong?"
                fullWidth
                required
                multiline
                minRows={3}
                disabled={saving}
                error={Boolean(fieldErrors.description)}
                helperText={fieldErrors.description ?? ' '}
                value={draft.description}
                onChange={(event) => {
                  setDraft({ ...draft, description: event.target.value });
                  setFieldErrors({});
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                select
                label="Category"
                fullWidth
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
              >
                {CATEGORIES.map((value) => (
                  <MenuItem key={value} value={value}>
                    {humanise(value)}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                select
                label="Priority"
                fullWidth
                value={draft.priority}
                onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
              >
                {Object.entries(PRIORITY_META).map(([value, meta]) => (
                  <MenuItem key={value} value={value}>
                    {meta.label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                select
                label="Building"
                fullWidth
                value={draft.building_id}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    building_id: event.target.value,
                    floor_id: '',
                    seat_id: '',
                    asset_id: '',
                  })
                }
              >
                <MenuItem value="">Not specified</MenuItem>
                {buildings.map((building) => (
                  <MenuItem key={building.id} value={building.id}>
                    {building.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                select
                label="Floor"
                fullWidth
                disabled={!draft.building_id}
                value={draft.floor_id}
                onChange={(event) =>
                  setDraft({ ...draft, floor_id: event.target.value, seat_id: '', asset_id: '' })
                }
              >
                <MenuItem value="">Not specified</MenuItem>
                {floors.map((floor) => (
                  <MenuItem key={floor.id} value={floor.id}>
                    Level {floor.level}
                    {floor.name ? ` — ${floor.name}` : ''}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={12}>
              <TextField
                select
                label="Seat"
                fullWidth
                disabled={!draft.floor_id}
                value={draft.seat_id}
                onChange={(event) => setDraft({ ...draft, seat_id: event.target.value, asset_id: '' })}
                helperText={draft.floor_id ? 'Optional, but it makes hotspots more precise' : ' '}
              >
                <MenuItem value="">Not specified</MenuItem>
                {seats.map((seat) => (
                  <MenuItem key={seat.id} value={seat.id}>
                    {seat.code}
                    {seat.description ? ` — ${seat.description}` : ''}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            {/* Always offered, never hidden. Hiding it when the chosen
                location happened to have nothing registered made the field
                look as though it did not exist, and an attribution nobody can
                see is an attribution nobody makes. The list narrows as the
                location narrows; the helper text says which case you are in. */}
            <Grid size={{ xs: 12 }}>
              <TextField
                select
                label="Equipment"
                fullWidth
                value={draft.asset_id}
                onChange={(event) => setDraft({ ...draft, asset_id: event.target.value })}
                disabled={assets.length === 0}
                helperText={
                  assets.length === 0
                    ? 'No equipment registered at this location yet'
                    : draft.building_id
                      ? 'Which unit failed, if the fault is with a specific one'
                      : 'Choose a location above to narrow this list'
                }
              >
                <MenuItem value="">Not equipment, or not sure</MenuItem>
                {assets.map((asset) => (
                  <MenuItem key={asset.id} value={asset.id}>
                    {asset.code} — {asset.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          </Grid>
          <Box sx={{ mt: 1 }}>
            <SimilarIncidents matches={duplicates} variant="draft" />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleCreate} disabled={!canSubmit || saving}>
            {saving ? 'Reporting…' : 'Report'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

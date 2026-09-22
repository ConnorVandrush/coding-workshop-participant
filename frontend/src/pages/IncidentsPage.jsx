/**
 * Incident list with search, filtering, pagination and reporting.
 *
 * Any signed-in persona can report an incident; what the list contains is
 * decided by the API, which scopes rows to the caller's role.
 */

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
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
import IncidentList from '../components/IncidentList';
import {
  fetchBuildings,
  fetchFloors,
  fetchSeats,
  selectBuildings,
  selectFloors,
} from '../store/facilitiesSlice';
import {
  createIncident,
  fetchIncidents,
  resetFilters,
  selectFilters,
  selectIncidents,
  setFilters,
  setPage,
} from '../store/incidentsSlice';
import { notify } from '../store/uiSlice';
import { errorFields, errorMessage } from '../store/thunkUtils';
import { CATEGORIES, PRIORITY_META, humanise } from '../theme';

const EMPTY_DRAFT = {
  title: '',
  description: '',
  category: 'OTHER',
  priority: 'MEDIUM',
  building_id: '',
  floor_id: '',
  seat_id: '',
};

/**
 * Render the incident list page.
 *
 * @returns {JSX.Element} The incidents page.
 */
export default function IncidentsPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const incidents = useSelector(selectIncidents);
  const filters = useSelector(selectFilters);
  const buildings = useSelector(selectBuildings);
  const floors = useSelector(selectFloors);
  const { total, page, pageSize, listStatus, listError, saving } = useSelector((state) => state.incidents);

  const [dialogOpen, setDialogOpen] = useState(false);
  // Per-field messages from a rejected submission.
  const [fieldErrors, setFieldErrors] = useState({});
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const seats = useSelector((state) => state.facilities.seatsByFloor[draft.floor_id] ?? []);

  useEffect(() => {
    dispatch(fetchBuildings());
  }, [dispatch]);

  // Re-fetch whenever a filter or the page changes. The search box is included,
  // so typing narrows the list as the user goes.
  useEffect(() => {
    const timer = setTimeout(() => dispatch(fetchIncidents()), 250);
    return () => clearTimeout(timer);
  }, [dispatch, filters, page]);

  // Load the floors of whichever building the reporter picks in the dialog.
  useEffect(() => {
    if (draft.building_id) dispatch(fetchFloors(draft.building_id));
  }, [dispatch, draft.building_id]);

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
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
          Report incident
        </Button>
      </Stack>

      <IncidentFilters
        filters={filters}
        buildings={buildings}
        onChange={(update) => dispatch(setFilters(update))}
        onReset={() => dispatch(resetFilters())}
      />

      {listStatus === 'loading' ? <LinearProgress sx={{ mb: 2 }} /> : null}
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
                  setDraft({ ...draft, building_id: event.target.value, floor_id: '', seat_id: '' })
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
                onChange={(event) => setDraft({ ...draft, floor_id: event.target.value, seat_id: '' })}
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
                onChange={(event) => setDraft({ ...draft, seat_id: event.target.value })}
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
          </Grid>
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

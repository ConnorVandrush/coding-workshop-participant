/**
 * Engineer roster: who is available, what they specialise in, and how loaded
 * they are.
 *
 * Creating a profile promotes an existing account to the engineer role, which
 * is why the form picks from registered users rather than collecting a
 * password — credential handling stays in the single registration path.
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
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import { useDispatch, useSelector } from 'react-redux';
import { selectUser } from '../store/authSlice';
import {
  createEngineer,
  deleteEngineer,
  fetchEngineers,
  fetchUsers,
  selectEngineers,
  selectUsers,
  updateEngineer,
} from '../store/engineersSlice';
import { notify } from '../store/uiSlice';
import { errorFields, errorMessage } from '../store/thunkUtils';
import { CATEGORIES, humanise } from '../theme';

/**
 * Render the engineers page.
 *
 * @returns {JSX.Element} The engineers page.
 */
export default function EngineersPage() {
  const dispatch = useDispatch();
  const user = useSelector(selectUser);
  const engineers = useSelector(selectEngineers);
  const users = useSelector(selectUsers);
  const { status } = useSelector((state) => state.engineers);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState({ user_id: '', specialties: [], max_active_incidents: 8, phone: '' });
  // Per-field messages from a rejected request, shown beside the input each
  // one refers to rather than only in a toast.
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role === 'facility_admin';

  useEffect(() => {
    dispatch(fetchEngineers());
    if (isAdmin) dispatch(fetchUsers());
  }, [dispatch, isAdmin]);

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

  /** Create an engineer profile from the dialog. */
  const handleCreate = async () => {
    setSaving(true);
    const result = await dispatch(
      createEngineer({
        user_id: Number(draft.user_id),
        specialties: draft.specialties,
        max_active_incidents: Number(draft.max_active_incidents),
        phone: draft.phone || null,
      }),
    );
    setSaving(false);
    if (report(result, 'Engineer profile created')) {
      setDialogOpen(false);
      setDraft({ user_id: '', specialties: [], max_active_incidents: 8, phone: '' });
      dispatch(fetchUsers());
    }
  };

  /**
   * Toggle an engineer's availability.
   *
   * @param {object} engineer The engineer profile.
   * @param {boolean} isAvailable The new availability.
   */
  const toggleAvailability = async (engineer, isAvailable) => {
    report(
      await dispatch(updateEngineer({ id: engineer.id, payload: { is_available: isAvailable } })),
      isAvailable ? `${engineer.full_name} marked available` : `${engineer.full_name} marked unavailable`,
    );
  };

  /**
   * Remove an engineer profile after confirmation.
   *
   * @param {object} engineer The engineer profile.
   */
  const removeEngineer = async (engineer) => {
    if (
      !window.confirm(
        `Remove ${engineer.full_name}'s engineer profile? Their open incidents become unassigned and the account drops to employee.`,
      )
    ) {
      return;
    }
    report(await dispatch(deleteEngineer(engineer.id)), 'Engineer profile removed');
  };

  // Only accounts without a profile can be promoted.
  const candidates = users.filter(
    (candidate) => !engineers.some((engineer) => engineer.user_id === candidate.id),
  );

  return (
    <Box sx={{ py: 3 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
       
       
        sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: "space-between", mb: 3 }}
      >
        <Box>
          <Typography variant="h1">Engineers</Typography>
          <Typography variant="body2" color="text.secondary">
            Availability, specialties and current workload.
          </Typography>
        </Box>
        {isAdmin ? (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
            Add engineer
          </Button>
        ) : null}
      </Stack>

      {status === 'loading' ? <LinearProgress sx={{ mb: 2 }} /> : null}

      <Grid container spacing={2}>
        {engineers.map((engineer) => {
          const load = engineer.max_active_incidents
            ? Math.round((engineer.active_incidents / engineer.max_active_incidents) * 100)
            : 0;
          return (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={engineer.id}>
              <Card variant="outlined" sx={{ height: '100%' }}>
                <CardContent>
                  <Stack direction="row" sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
                    <Box>
                      <Typography variant="h3">{engineer.full_name}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {engineer.email}
                      </Typography>
                    </Box>
                    <Chip
                      size="small"
                      label={engineer.has_capacity ? 'Has capacity' : 'At capacity'}
                      color={engineer.has_capacity ? 'success' : 'warning'}
                    />
                  </Stack>

                  <Typography variant="body2" sx={{ mt: 2 }}>
                    <strong>{engineer.active_incidents}</strong> of {engineer.max_active_incidents} active
                    {` (${load}%)`}
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(100, load)}
                    color={load >= 100 ? 'warning' : 'primary'}
                    sx={{ height: 6, borderRadius: 3, mt: 0.5 }}
                  />

                  <Stack direction="row" spacing={0.5} sx={{ mt: 2, flexWrap: 'wrap', rowGap: 0.5 }}>
                    {engineer.specialties.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        No specialties recorded
                      </Typography>
                    ) : (
                      engineer.specialties.map((specialty) => (
                        <Chip key={specialty} size="small" variant="outlined" label={humanise(specialty)} />
                      ))
                    )}
                  </Stack>

                  {isAdmin ? (
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 2 }}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={engineer.is_available}
                            onChange={(event) => toggleAvailability(engineer, event.target.checked)}
                          />
                        }
                        label="Available"
                      />
                      <Box sx={{ flexGrow: 1 }} />
                      <Button size="small" color="error" onClick={() => removeEngineer(engineer)}>
                        Remove
                      </Button>
                    </Stack>
                  ) : (
                    <Chip
                      size="small"
                      sx={{ mt: 2 }}
                      label={engineer.is_available ? 'Available' : 'Unavailable'}
                      color={engineer.is_available ? 'success' : 'default'}
                    />
                  )}
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      {engineers.length === 0 && status !== 'loading' ? (
        <Alert severity="info">No engineer profiles yet.</Alert>
      ) : null}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add an engineer</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              select
              label="Account"
              fullWidth
              required
              disabled={saving}
              error={Boolean(fieldErrors.user_id)}
              value={draft.user_id}
              onChange={(event) => {
                setDraft({ ...draft, user_id: event.target.value });
                setFieldErrors({});
              }}
              helperText={fieldErrors.user_id ?? 'The person must already have registered'}
            >
              {candidates.map((candidate) => (
                <MenuItem key={candidate.id} value={candidate.id}>
                  {candidate.full_name} — {candidate.email}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Specialties"
              fullWidth
              slotProps={{ select: { multiple: true } }}
              value={draft.specialties}
              onChange={(event) => setDraft({ ...draft, specialties: event.target.value })}
            >
              {CATEGORIES.map((category) => (
                <MenuItem key={category} value={category}>
                  {humanise(category)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Maximum active incidents"
              type="number"
              fullWidth
              required
              disabled={saving}
              error={Boolean(fieldErrors.max_active_incidents)}
              helperText={fieldErrors.max_active_incidents ?? ' '}
              value={draft.max_active_incidents}
              onChange={(event) => {
                setDraft({ ...draft, max_active_incidents: event.target.value });
                setFieldErrors({});
              }}
            />
            <TextField
              label="Phone"
              fullWidth
              disabled={saving}
              error={Boolean(fieldErrors.phone)}
              helperText={fieldErrors.phone ?? ' '}
              value={draft.phone}
              onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleCreate} disabled={!draft.user_id || saving}>
            Create profile
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

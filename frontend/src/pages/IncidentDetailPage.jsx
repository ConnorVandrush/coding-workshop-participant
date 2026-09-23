/**
 * Single incident: details, workflow controls, assignment and the note thread.
 *
 * Which controls appear is decided by the incident's own
 * `allowed_transitions` plus the caller's role, so the UI never offers a move
 * the API would reject. The API remains the authority — this only avoids
 * dead-end buttons.
 */

import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DeleteIcon from '@mui/icons-material/Delete';
import LockIcon from '@mui/icons-material/Lock';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import LiveStatus from '../components/LiveStatus';
import SimilarIncidents from '../components/SimilarIncidents';
import WorkflowDiagram from '../components/WorkflowDiagram';
import usePolling from '../hooks/usePolling';
import { EscalationChip, PriorityChip, StatusChip } from '../components/StatusChip';
import { selectUser } from '../store/authSlice';
import { fetchEngineers, selectEngineers } from '../store/engineersSlice';
import { fetchWorkflow, selectWorkflow } from '../store/dashboardSlice';
import {
  addNote,
  assignIncident,
  changeStatus,
  clearCurrent,
  deleteIncident,
  escalateIncident,
  fetchIncident,
  fetchNotes,
  fetchRelated,
  selectCurrentIncident,
  selectNotes,
  selectRelated,
} from '../store/incidentsSlice';
import { notify } from '../store/uiSlice';
import { errorMessage } from '../store/thunkUtils';
import { STATUS_META, formatDateTime, humanise } from '../theme';

/**
 * Render the incident detail page.
 *
 * @returns {JSX.Element} The detail page.
 */
export default function IncidentDetailPage() {
  const { incidentId } = useParams();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const incident = useSelector(selectCurrentIncident);
  const notes = useSelector(selectNotes);
  const related = useSelector(selectRelated);
  const engineers = useSelector(selectEngineers);
  const workflow = useSelector(selectWorkflow);
  const user = useSelector(selectUser);
  const { currentStatus, saving, currentUpdatedAt } = useSelector((state) => state.incidents);

  const [noteBody, setNoteBody] = useState('');
  const [noteInternal, setNoteInternal] = useState(false);
  const [statusTarget, setStatusTarget] = useState('');
  const [statusReason, setStatusReason] = useState('');
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateReason, setEscalateReason] = useState('');

  useEffect(() => {
    dispatch(fetchIncident(incidentId));
    dispatch(fetchNotes(incidentId));
    dispatch(fetchRelated(incidentId));
    dispatch(fetchWorkflow());
    return () => {
      dispatch(clearCurrent());
    };
  }, [dispatch, incidentId]);

  // Refreshing the incident and its notes is what makes the thread feel live
  // for the reporter while an engineer is working on it. Suspended while the
  // user is mid-write so a poll cannot overwrite a response in flight.
  const refresh = useCallback(() => {
    dispatch(fetchIncident(incidentId));
    dispatch(fetchNotes(incidentId));
  }, [dispatch, incidentId]);
  usePolling(refresh, { enabled: !saving });

  const isAdmin = user?.role === 'facility_admin';
  const isEngineer = user?.role === 'engineer';
  const isReporter = incident?.reporter?.id === user?.id;

  useEffect(() => {
    if (isAdmin || isEngineer) dispatch(fetchEngineers());
  }, [dispatch, isAdmin, isEngineer]);

  if (currentStatus === 'loading' && !incident) return <LinearProgress aria-label="Loading the incident" sx={{ mt: 2 }} />;
  if (currentStatus === 'failed') {
    return (
      <Alert severity="error" sx={{ mt: 3 }}>
        This incident does not exist, or it is outside what your role can see.
      </Alert>
    );
  }
  if (!incident) return null;

  const canAssign = isAdmin || isEngineer;
  const canDriveWorkflow =
    isAdmin || (isEngineer && incident.assignee?.user_id === user?.id) || isReporter;

  /**
   * Report the outcome of a dispatched thunk as a toast.
   *
   * @param {object} result The dispatch result.
   * @param {string} successMessage Message shown when the call succeeded.
   * @returns {boolean} Whether the call succeeded.
   */
  const report = (result, successMessage) => {
    const ok = result.meta.requestStatus === 'fulfilled';
    dispatch(
      notify({
        message: ok ? successMessage : errorMessage(result.payload, 'The request failed'),
        severity: ok ? 'success' : 'error',
      }),
    );
    return ok;
  };

  /** Apply the selected status transition. */
  const submitStatus = async () => {
    const body = { incidentId, status: statusTarget };
    if (statusTarget === 'BLOCKED') body.reason = statusReason;
    if (statusTarget === 'RESOLVED') body.resolution = statusReason;
    const result = await dispatch(changeStatus(body));
    if (report(result, `Moved to ${STATUS_META[statusTarget]?.label ?? statusTarget}`)) {
      setStatusTarget('');
      setStatusReason('');
      dispatch(fetchNotes(incidentId));
    }
  };

  /**
   * Assign or unassign the incident.
   *
   * @param {number|string} engineerId Engineer profile id, or '' to unassign.
   */
  const submitAssignment = async (engineerId) => {
    const result = await dispatch(
      assignIncident({ incidentId, engineerId: engineerId === '' ? null : Number(engineerId) }),
    );
    if (report(result, engineerId === '' ? 'Incident unassigned' : 'Incident assigned')) {
      dispatch(fetchNotes(incidentId));
    }
  };

  /** Raise an escalation with a reason. */
  const submitEscalation = async () => {
    const result = await dispatch(
      escalateIncident({ incidentId, is_escalated: true, reason: escalateReason }),
    );
    if (report(result, 'Incident escalated')) {
      setEscalateOpen(false);
      setEscalateReason('');
      dispatch(fetchNotes(incidentId));
    }
  };

  /** Clear an escalation (facility admins only). */
  const clearEscalation = async () => {
    const result = await dispatch(escalateIncident({ incidentId, is_escalated: false }));
    if (report(result, 'Escalation cleared')) dispatch(fetchNotes(incidentId));
  };

  /** Post a note to the thread. */
  const submitNote = async () => {
    const result = await dispatch(addNote({ incidentId, body: noteBody, isInternal: noteInternal }));
    if (report(result, 'Note added')) {
      setNoteBody('');
      setNoteInternal(false);
    }
  };

  /** Delete the incident, after confirmation. */
  const removeIncident = async () => {
    const confirmed = window.confirm(
      `Permanently delete incident #${incident.id}? This also removes its notes and cannot be undone.`,
    );
    if (!confirmed) return;
    const result = await dispatch(deleteIncident(incidentId));
    if (report(result, 'Incident deleted')) navigate('/incidents');
  };

  const requiresText = statusTarget === 'BLOCKED' || statusTarget === 'RESOLVED';

  return (
    <Box sx={{ py: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 2 }}>
        <IconButton onClick={() => navigate('/incidents')} aria-label="Back to incidents">
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h1" sx={{ flexGrow: 1 }}>
          #{incident.id}
        </Typography>
        <LiveStatus
          loading={currentStatus === 'loading'}
          updatedAt={currentUpdatedAt}
          onRefresh={refresh}
          label="incident"
        />
        {isAdmin ? (
          <Tooltip title="Delete incident">
            <IconButton color="error" onClick={removeIncident} aria-label="Delete incident">
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
              <StatusChip status={incident.status} size="medium" />
              <PriorityChip priority={incident.priority} size="medium" />
              <EscalationChip escalated={incident.is_escalated} />
            </Stack>
            <Typography variant="h2" gutterBottom>
              {incident.title}
            </Typography>
            <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap', mb: 2 }}>
              {incident.description}
            </Typography>

            {incident.blocked_reason ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                <strong>Blocked:</strong> {incident.blocked_reason}
              </Alert>
            ) : null}
            {incident.resolution ? (
              <Alert severity="success" sx={{ mb: 2 }}>
                <strong>Resolution:</strong> {incident.resolution}
              </Alert>
            ) : null}
            {incident.escalation_note ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                <strong>Escalation:</strong> {incident.escalation_note}
              </Alert>
            ) : null}

            <Divider sx={{ my: 2 }} />
            <Grid container spacing={2}>
              {[
                ['Category', humanise(incident.category)],
                ['Reported by', incident.reporter.full_name],
                ['Assigned to', incident.assignee?.full_name ?? 'Nobody yet'],
                [
                  'Location',
                  incident.location.building_name
                    ? [
                        incident.location.building_name,
                        incident.location.floor_level !== null
                          ? `Level ${incident.location.floor_level}`
                          : null,
                        incident.location.seat_code,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : 'Not specified',
                ],
                ['Reported', formatDateTime(incident.created_at)],
                ['Acknowledged', formatDateTime(incident.acknowledged_at)],
                ['Resolved', formatDateTime(incident.resolved_at)],
                ['Closed', formatDateTime(incident.closed_at)],
              ].map(([label, value]) => (
                <Grid size={{ xs: 6, sm: 3 }} key={label}>
                  <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase' }}>
                    {label}
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {value}
                  </Typography>
                </Grid>
              ))}
            </Grid>
          </Paper>

          {related.length > 0 && (
            <Box sx={{ mb: 2 }}>
              <SimilarIncidents matches={related} variant="detail" />
            </Box>
          )}

          <Box sx={{ mb: 2 }}>
            <WorkflowDiagram
              workflow={workflow}
              currentStatus={incident.status}
              allowedTransitions={incident.allowed_transitions}
            />
          </Box>

          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography variant="h3" gutterBottom>
              Notes ({notes.length})
            </Typography>
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              {notes.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No notes yet.
                </Typography>
              ) : (
                notes.map((note) => (
                  <Card key={note.id} variant="outlined" sx={{ bgcolor: note.is_internal ? 'grey.50' : 'inherit' }}>
                    <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
                        <Typography variant="subtitle2">{note.author.full_name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatDateTime(note.created_at)}
                        </Typography>
                        {note.is_internal ? (
                          <Tooltip title="Internal — not visible to employees">
                            <LockIcon fontSize="inherit" color="action" />
                          </Tooltip>
                        ) : null}
                      </Stack>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                        {note.body}
                      </Typography>
                    </CardContent>
                  </Card>
                ))
              )}
            </Stack>

            {incident.status === 'CLOSED' ? (
              <Alert severity="info">This incident is closed; notes can no longer be added.</Alert>
            ) : (
              <Stack spacing={1}>
                <TextField
                  label="Add a note"
                  multiline
                  minRows={2}
                  fullWidth
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                />
                <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                  {isAdmin || isEngineer ? (
                    <FormControlLabel
                      control={
                        <Switch
                          checked={noteInternal}
                          onChange={(event) => setNoteInternal(event.target.checked)}
                        />
                      }
                      label="Internal note"
                    />
                  ) : (
                    <Box />
                  )}
                  <Button
                    variant="contained"
                    onClick={submitNote}
                    disabled={saving || noteBody.trim().length === 0}
                  >
                    Post note
                  </Button>
                </Stack>
              </Stack>
            )}
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          {canAssign ? (
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="h3" gutterBottom>
                Assignment
              </Typography>
              <TextField
                select
                fullWidth
                label="Assigned engineer"
                value={incident.assignee?.id ?? ''}
                onChange={(event) => submitAssignment(event.target.value)}
                disabled={saving}
                helperText={isEngineer ? 'Engineers may only assign work to themselves' : ' '}
              >
                <MenuItem value="">Unassigned</MenuItem>
                {engineers.map((engineer) => (
                  <MenuItem key={engineer.id} value={engineer.id} disabled={!engineer.has_capacity}>
                    {engineer.full_name} ({engineer.active_incidents}/{engineer.max_active_incidents})
                    {engineer.has_capacity ? '' : ' — at capacity'}
                  </MenuItem>
                ))}
              </TextField>
            </Paper>
          ) : null}

          {canDriveWorkflow && incident.allowed_transitions.length > 0 ? (
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="h3" gutterBottom>
                Change status
              </Typography>
              <Stack spacing={2}>
                <TextField
                  select
                  fullWidth
                  label="Move to"
                  value={statusTarget}
                  onChange={(event) => {
                    setStatusTarget(event.target.value);
                    setStatusReason('');
                  }}
                >
                  <MenuItem value="">Choose a status</MenuItem>
                  {incident.allowed_transitions.map((status) => (
                    <MenuItem key={status} value={status}>
                      {STATUS_META[status]?.label ?? status}
                    </MenuItem>
                  ))}
                </TextField>
                {requiresText ? (
                  <TextField
                    label={statusTarget === 'BLOCKED' ? 'Why is it blocked?' : 'How was it resolved?'}
                    multiline
                    minRows={2}
                    fullWidth
                    required
                    value={statusReason}
                    onChange={(event) => setStatusReason(event.target.value)}
                  />
                ) : null}
                <Button
                  variant="contained"
                  onClick={submitStatus}
                  disabled={saving || !statusTarget || (requiresText && statusReason.trim().length === 0)}
                >
                  Apply
                </Button>
              </Stack>
            </Paper>
          ) : null}

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" gutterBottom>
              Escalation
            </Typography>
            {incident.is_escalated ? (
              <Stack spacing={1}>
                <Alert severity="error">This incident is escalated.</Alert>
                {isAdmin ? (
                  <Button onClick={clearEscalation} disabled={saving}>
                    Clear escalation
                  </Button>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    Only a facility admin can clear an escalation.
                  </Typography>
                )}
              </Stack>
            ) : (
              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  Escalate if this is blocking work or poses a safety risk.
                </Typography>
                <Button variant="outlined" color="error" onClick={() => setEscalateOpen(true)}>
                  Escalate
                </Button>
              </Stack>
            )}
          </Paper>
        </Grid>
      </Grid>

      <Dialog open={escalateOpen} onClose={() => setEscalateOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Escalate incident</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Why does this need escalating?"
            multiline
            minRows={3}
            fullWidth
            sx={{ mt: 1 }}
            value={escalateReason}
            onChange={(event) => setEscalateReason(event.target.value)}
          />
          {!isAdmin ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              A facility admin reviews the priority; escalating flags it for attention.
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEscalateOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={submitEscalation} disabled={saving}>
            Escalate
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/**
 * The form for registering or editing a unit of equipment.
 *
 * Shared by the facilities screen, where equipment is added alongside the
 * floors and seats it sits on, and by the maintenance screen, where the
 * register is managed as a whole. One component rather than two forms: the
 * fields decide what the maintenance figures can say, so the two screens
 * disagreeing about which of them exist would be a real defect rather than a
 * cosmetic one.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import PropTypes from 'prop-types';

/**
 * Render the equipment dialog.
 *
 * @param {object} props Component props.
 * @param {boolean} props.open Whether the dialog is showing.
 * @param {string} props.title Dialog heading.
 * @param {object} props.draft Current draft values.
 * @param {Function} props.onChange Called with the next draft.
 * @param {Function} props.onSubmit Called when the form is submitted.
 * @param {Function} props.onClose Called when the dialog is dismissed.
 * @param {object} [props.fieldErrors] Per-field messages from a rejection.
 * @param {boolean} [props.saving] Disables the submit button while in flight.
 * @param {Array} [props.buildings] Buildings to offer.
 * @param {Array} [props.floors] Floors of the chosen building.
 * @param {Array} [props.seats] Seats of the chosen floor.
 * @param {boolean} [props.lockLocation] Hide the location fields, for when the
 *   caller already fixed the position (adding from a floor, say).
 * @param {string} [props.locationLabel] What that fixed position is.
 * @returns {JSX.Element} The dialog.
 */
export default function EquipmentDialog({
  open,
  title,
  draft,
  onChange,
  onSubmit,
  onClose,
  fieldErrors = {},
  saving = false,
  buildings = [],
  floors = [],
  seats = [],
  lockLocation = false,
  locationLabel = '',
}) {
  const set = (patch) => onChange({ ...draft, ...patch });
  const complete = draft.code.trim() && draft.name.trim() && draft.asset_type.trim();

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {lockLocation && locationLabel ? (
          <Alert severity="info" sx={{ mb: 2 }}>
            Placed at {locationLabel}.
          </Alert>
        ) : null}
        <Grid container spacing={2} sx={{ mt: 0 }}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Asset tag"
              fullWidth
              required
              value={draft.code}
              onChange={(event) => set({ code: event.target.value })}
              error={Boolean(fieldErrors.code)}
              helperText={fieldErrors.code ?? 'The label on the unit itself'}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Class"
              fullWidth
              required
              value={draft.asset_type}
              onChange={(event) => set({ asset_type: event.target.value })}
              error={Boolean(fieldErrors.asset_type)}
              helperText={fieldErrors.asset_type ?? 'For example Projector or Air handling unit'}
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <TextField
              label="Name"
              fullWidth
              required
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              error={Boolean(fieldErrors.name)}
              helperText={fieldErrors.name ?? ' '}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Manufacturer"
              fullWidth
              value={draft.manufacturer}
              onChange={(event) => set({ manufacturer: event.target.value })}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Model"
              fullWidth
              value={draft.model}
              onChange={(event) => set({ model: event.target.value })}
            />
          </Grid>

          {lockLocation ? null : (
            <>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  select
                  label="Building"
                  fullWidth
                  value={draft.building_id}
                  onChange={(event) => set({ building_id: event.target.value, floor_id: '', seat_id: '' })}
                >
                  <MenuItem value="">Not specified</MenuItem>
                  {buildings.map((building) => (
                    <MenuItem key={building.id} value={building.id}>
                      {building.name}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  select
                  label="Floor"
                  fullWidth
                  disabled={!draft.building_id}
                  value={draft.floor_id}
                  onChange={(event) => set({ floor_id: event.target.value, seat_id: '' })}
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
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  select
                  label="Seat"
                  fullWidth
                  disabled={!draft.floor_id}
                  value={draft.seat_id}
                  onChange={(event) => set({ seat_id: event.target.value })}
                >
                  <MenuItem value="">Not specified</MenuItem>
                  {seats.map((seat) => (
                    <MenuItem key={seat.id} value={seat.id}>
                      {seat.code}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
            </>
          )}

          {lockLocation ? (
            <Grid size={{ xs: 12 }}>
              <TextField
                select
                label="Seat"
                fullWidth
                value={draft.seat_id}
                onChange={(event) => set({ seat_id: event.target.value })}
                helperText="Leave unset for equipment serving the whole floor"
              >
                <MenuItem value="">Serves the whole floor</MenuItem>
                {seats.map((seat) => (
                  <MenuItem key={seat.id} value={seat.id}>
                    {seat.code}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          ) : null}

          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Installed on"
              type="date"
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
              value={draft.installed_on}
              onChange={(event) => set({ installed_on: event.target.value })}
              helperText="Without this, age and time between failures cannot be measured"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Replace after (months)"
              type="number"
              fullWidth
              value={draft.expected_life_months}
              onChange={(event) => set({ expected_life_months: event.target.value })}
              error={Boolean(fieldErrors.expected_life_months)}
              helperText={fieldErrors.expected_life_months ?? 'Expected service life of the unit'}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Service every (months)"
              type="number"
              fullWidth
              value={draft.service_interval_months}
              onChange={(event) => set({ service_interval_months: event.target.value })}
              error={Boolean(fieldErrors.service_interval_months)}
              helperText={fieldErrors.service_interval_months ?? 'How often it needs attention'}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="Last serviced"
              type="date"
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
              value={draft.last_serviced_on}
              onChange={(event) => set({ last_serviced_on: event.target.value })}
              helperText="Left blank, the first service is due an interval after installation"
            />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={onSubmit} disabled={saving || !complete}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

EquipmentDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  title: PropTypes.string.isRequired,
  draft: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  fieldErrors: PropTypes.object,
  saving: PropTypes.bool,
  buildings: PropTypes.array,
  floors: PropTypes.array,
  seats: PropTypes.array,
  lockLocation: PropTypes.bool,
  locationLabel: PropTypes.string,
};

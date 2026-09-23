/**
 * Facility hierarchy management: buildings, their floors and their seats.
 *
 * Everyone can browse the hierarchy — employees need it to place an incident —
 * but the create and delete controls only render for facility admins, matching
 * what the API permits.
 */

import { useEffect, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CancelIcon from '@mui/icons-material/Cancel';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useDispatch, useSelector } from 'react-redux';
import EquipmentDialog from '../components/EquipmentDialog';
import { EMPTY_EQUIPMENT, equipmentPayload, serviceLabel } from '../components/equipmentDraft';
import { selectUser } from '../store/authSlice';
import {
  createBuilding,
  createFloor,
  createSeat,
  deleteBuilding,
  deleteFloor,
  deleteSeat,
  fetchBuildings,
  fetchFloors,
  fetchSeats,
  selectBuilding,
  selectBuildings,
  selectFloors,
} from '../store/facilitiesSlice';
import { createAsset, deleteAsset, fetchAssets, selectAssets } from '../store/maintenanceSlice';
import { notify } from '../store/uiSlice';
import { errorFields, errorMessage } from '../store/thunkUtils';

/**
 * Render the facilities page.
 *
 * @returns {JSX.Element} The facilities page.
 */
export default function FacilitiesPage() {
  const dispatch = useDispatch();
  const user = useSelector(selectUser);
  const buildings = useSelector(selectBuildings);
  const floors = useSelector(selectFloors);
  const seatsByFloor = useSelector((state) => state.facilities.seatsByFloor);
  const assets = useSelector(selectAssets);
  const selectedBuildingId = useSelector((state) => state.facilities.selectedBuildingId);

  const [buildingDraft, setBuildingDraft] = useState({ name: '', address: '' });
  const [floorDraft, setFloorDraft] = useState({ level: '', name: '' });
  const [seatDrafts, setSeatDrafts] = useState({});
  // Equipment is added from the floor it sits on, the same way seats are, so
  // the dialog is opened with that floor already fixed.
  const [equipmentFor, setEquipmentFor] = useState(null);
  const [equipmentDraft, setEquipmentDraft] = useState(EMPTY_EQUIPMENT);
  // Per-field messages from a rejected request, so each one can be shown
  // beside the input that caused it rather than only in a toast.
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const isAdmin = user?.role === 'facility_admin';

  useEffect(() => {
    dispatch(fetchBuildings());
  }, [dispatch]);

  useEffect(() => {
    if (selectedBuildingId) dispatch(fetchFloors(selectedBuildingId));
    // The whole building's equipment at once: the floors are an accordion, and
    // a request per floor would refetch every time one is opened.
    if (selectedBuildingId) dispatch(fetchAssets({ building_id: selectedBuildingId, limit: 500 }));
  }, [dispatch, selectedBuildingId]);

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

  /**
   * Open the equipment dialog against one floor.
   *
   * @param {object} floor The floor the unit sits on.
   */
  const openEquipment = (floor) => {
    dispatch(fetchSeats(floor.id));
    setEquipmentFor(floor);
    setEquipmentDraft({
      ...EMPTY_EQUIPMENT,
      building_id: selectedBuildingId,
      floor_id: floor.id,
    });
  };

  /** Register the drafted unit on the floor the dialog was opened from. */
  const addEquipment = async () => {
    setSaving(true);
    const result = await dispatch(createAsset(equipmentPayload(equipmentDraft)));
    setSaving(false);
    if (report(result, 'Equipment registered')) {
      setEquipmentFor(null);
      setEquipmentDraft(EMPTY_EQUIPMENT);
      dispatch(fetchAssets({ building_id: selectedBuildingId, limit: 500 }));
    }
  };

  /** Create a building from the draft form. */
  const addBuilding = async () => {
    setSaving(true);
    const result = await dispatch(createBuilding({ name: buildingDraft.name, address: buildingDraft.address || null }));
    setSaving(false);
    if (report(result, 'Building created')) setBuildingDraft({ name: '', address: '' });
  };

  /** Add a floor to the selected building. */
  const addFloor = async () => {
    setSaving(true);
    const result = await dispatch(
      createFloor({
        buildingId: selectedBuildingId,
        payload: { level: Number(floorDraft.level), name: floorDraft.name || null },
      }),
    );
    setSaving(false);
    if (report(result, 'Floor added')) setFloorDraft({ level: '', name: '' });
  };

  /**
   * Add a seat to a floor.
   *
   * @param {number} floorId The floor to add to.
   */
  const addSeat = async (floorId) => {
    const code = (seatDrafts[floorId] ?? '').trim();
    if (!code) return;
    setSaving(true);
    const result = await dispatch(createSeat({ floorId, payload: { code } }));
    setSaving(false);
    if (report(result, 'Seat added')) setSeatDrafts({ ...seatDrafts, [floorId]: '' });
  };

  /**
   * Delete a record after confirming.
   *
   * @param {string} label What is being deleted, for the prompt.
   * @param {Function} thunk Zero-argument function dispatching the delete.
   */
  const confirmDelete = async (label, thunk) => {
    if (!window.confirm(`Delete ${label}? Anything nested under it is removed too.`)) return;
    report(await thunk(), `${label} deleted`);
  };

  return (
    <Box sx={{ py: 3 }}>
      <Typography variant="h1" gutterBottom>
        Facilities
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Buildings, floors and seats. Incidents are reported against these locations, which is what
        makes the hotspot report meaningful.
      </Typography>

      {isAdmin ? (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Typography variant="h3" gutterBottom>
            Add a building
          </Typography>
          <Grid container spacing={2} sx={{ alignItems: 'center' }}>
            <Grid size={{ xs: 12, sm: 5 }}>
              <TextField
                label="Name"
                fullWidth
                required
                disabled={saving}
                error={Boolean(fieldErrors.name)}
                helperText={fieldErrors.name ?? ' '}
                value={buildingDraft.name}
                onChange={(event) => {
                  setBuildingDraft({ ...buildingDraft, name: event.target.value });
                  setFieldErrors({});
                }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 5 }}>
              <TextField
                label="Address"
                fullWidth
                disabled={saving}
                error={Boolean(fieldErrors.address)}
                helperText={fieldErrors.address ?? ' '}
                value={buildingDraft.address}
                onChange={(event) => setBuildingDraft({ ...buildingDraft, address: event.target.value })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 2 }}>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                fullWidth
                onClick={addBuilding}
                disabled={buildingDraft.name.trim().length === 0}
              >
                Add
              </Button>
            </Grid>
          </Grid>
        </Paper>
      ) : null}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper variant="outlined">
            <Typography variant="h3" sx={{ p: 2, pb: 1 }}>
              Buildings ({buildings.length})
            </Typography>
            <List dense>
              {buildings.map((building) => (
                <ListItem
                  key={building.id}
                  disablePadding
                  secondaryAction={
                    isAdmin ? (
                      <IconButton
                        edge="end"
                        aria-label={`Delete ${building.name}`}
                        onClick={() =>
                          confirmDelete(building.name, () => dispatch(deleteBuilding(building.id)))
                        }
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    ) : null
                  }
                >
                  <ListItemButton
                    selected={selectedBuildingId === building.id}
                    onClick={() => dispatch(selectBuilding(building.id))}
                  >
                    <ListItemText
                      primary={building.name}
                      secondary={`${building.floor_count} floors${building.address ? ` · ${building.address}` : ''}`}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
              {buildings.length === 0 ? (
                <ListItem>
                  <ListItemText secondary="No buildings defined yet." />
                </ListItem>
              ) : null}
            </List>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 8 }}>
          {!selectedBuildingId ? (
            <Alert severity="info">Select a building to see its floors and seats.</Alert>
          ) : (
            <Box>
              {isAdmin ? (
                <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                    <TextField
                      label="Level"
                      type="number"
                      required
                      disabled={saving}
                      error={Boolean(fieldErrors.level)}
                      helperText={fieldErrors.level ?? ' '}
                      value={floorDraft.level}
                      onChange={(event) => {
                        setFloorDraft({ ...floorDraft, level: event.target.value });
                        setFieldErrors({});
                      }}
                      sx={{ width: { sm: 140 } }}
                    />
                    <TextField
                      label="Floor name"
                      fullWidth
                      disabled={saving}
                      helperText=" "
                      value={floorDraft.name}
                      onChange={(event) => setFloorDraft({ ...floorDraft, name: event.target.value })}
                    />
                    <Button
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={addFloor}
                      disabled={floorDraft.level === ''}
                    >
                      Add floor
                    </Button>
                  </Stack>
                </Paper>
              ) : null}

              {floors.map((floor) => (
                <Accordion
                  key={floor.id}
                  onChange={(_, expanded) => {
                    if (expanded) dispatch(fetchSeats(floor.id));
                  }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", width: '100%' }}>
                      <Typography sx={{ fontWeight: 600 }}>Level {floor.level}</Typography>
                      {floor.name ? (
                        <Typography color="text.secondary">{floor.name}</Typography>
                      ) : null}
                      <Box sx={{ flexGrow: 1 }} />
                      <Chip size="small" label={`${floor.seat_count} seats`} />
                    </Stack>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, mb: 2 }}>
                      {(seatsByFloor[floor.id] ?? []).map((seat) => (
                        <Chip
                          key={seat.id}
                          label={seat.code}
                          // A floor now carries both seats and equipment, and
                          // MUI's delete icon has no accessible name of its
                          // own, so each chip says what it would remove.
                          deleteIcon={<CancelIcon titleAccess={`Delete seat ${seat.code}`} />}
                          onDelete={
                            isAdmin
                              ? () =>
                                  confirmDelete(`seat ${seat.code}`, () =>
                                    dispatch(deleteSeat({ floorId: floor.id, seatId: seat.id })),
                                  )
                              : undefined
                          }
                        />
                      ))}
                      {(seatsByFloor[floor.id] ?? []).length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          No seats on this floor.
                        </Typography>
                      ) : null}
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase' }}>
                      Equipment
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, mt: 1, mb: 2 }}>
                      {assets
                        .filter((asset) => asset.floor_id === floor.id)
                        .map((asset) => (
                          <Chip
                            key={asset.id}
                            // The service state travels with the unit wherever
                            // it is shown, so the estate view answers "what
                            // needs attention?" without a second screen.
                            color={asset.service_status === 'overdue' ? 'warning' : 'default'}
                            variant={asset.service_status === 'overdue' ? 'outlined' : 'filled'}
                            label={`${asset.code} · ${asset.seat_code ?? 'floor'} · ${serviceLabel(asset)}`}
                            deleteIcon={<CancelIcon titleAccess={`Delete equipment ${asset.code}`} />}
                            onDelete={
                              isAdmin
                                ? () =>
                                    confirmDelete(`equipment ${asset.code}`, () =>
                                      dispatch(deleteAsset(asset.id)),
                                    )
                                : undefined
                            }
                          />
                        ))}
                      {assets.filter((asset) => asset.floor_id === floor.id).length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          No equipment registered on this floor.
                        </Typography>
                      ) : null}
                    </Stack>
                    {isAdmin ? (
                      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                        <Button startIcon={<AddIcon />} onClick={() => openEquipment(floor)}>
                          Add equipment
                        </Button>
                      </Stack>
                    ) : null}
                    {isAdmin ? (
                      <Stack direction="row" spacing={1}>
                        <TextField
                          label="Seat code"
                          required
                          disabled={saving}
                          error={Boolean(fieldErrors.code)}
                          helperText={fieldErrors.code ?? ' '}
                          value={seatDrafts[floor.id] ?? ''}
                          onChange={(event) => {
                            setSeatDrafts({ ...seatDrafts, [floor.id]: event.target.value });
                            setFieldErrors({});
                          }}
                        />
                        <Button onClick={() => addSeat(floor.id)}>Add seat</Button>
                        <Box sx={{ flexGrow: 1 }} />
                        <Button
                          color="error"
                          onClick={() =>
                            confirmDelete(`level ${floor.level}`, () => dispatch(deleteFloor(floor.id)))
                          }
                        >
                          Delete floor
                        </Button>
                      </Stack>
                    ) : null}
                  </AccordionDetails>
                </Accordion>
              ))}
              {floors.length === 0 ? (
                <Alert severity="info">This building has no floors yet.</Alert>
              ) : null}
            </Box>
          )}
        </Grid>
      </Grid>

      <EquipmentDialog
        open={Boolean(equipmentFor)}
        title="Register equipment"
        draft={equipmentDraft}
        onChange={setEquipmentDraft}
        onSubmit={addEquipment}
        onClose={() => setEquipmentFor(null)}
        fieldErrors={fieldErrors}
        saving={saving}
        seats={equipmentFor ? seatsByFloor[equipmentFor.id] ?? [] : []}
        lockLocation
        locationLabel={
          equipmentFor
            ? `${buildings.find((building) => building.id === selectedBuildingId)?.name ?? ''} · Level ${equipmentFor.level}`
            : ''
        }
      />
    </Box>
  );
}

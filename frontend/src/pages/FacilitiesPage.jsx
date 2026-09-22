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
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useDispatch, useSelector } from 'react-redux';
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
import { notify } from '../store/uiSlice';

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
  const selectedBuildingId = useSelector((state) => state.facilities.selectedBuildingId);

  const [buildingDraft, setBuildingDraft] = useState({ name: '', address: '' });
  const [floorDraft, setFloorDraft] = useState({ level: '', name: '' });
  const [seatDrafts, setSeatDrafts] = useState({});

  const isAdmin = user?.role === 'facility_admin';

  useEffect(() => {
    dispatch(fetchBuildings());
  }, [dispatch]);

  useEffect(() => {
    if (selectedBuildingId) dispatch(fetchFloors(selectedBuildingId));
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
    dispatch(
      notify({
        message: ok ? successMessage : (result.payload ?? 'The request failed'),
        severity: ok ? 'success' : 'error',
      }),
    );
    return ok;
  };

  /** Create a building from the draft form. */
  const addBuilding = async () => {
    const result = await dispatch(createBuilding({ name: buildingDraft.name, address: buildingDraft.address || null }));
    if (report(result, 'Building created')) setBuildingDraft({ name: '', address: '' });
  };

  /** Add a floor to the selected building. */
  const addFloor = async () => {
    const result = await dispatch(
      createFloor({
        buildingId: selectedBuildingId,
        payload: { level: Number(floorDraft.level), name: floorDraft.name || null },
      }),
    );
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
    const result = await dispatch(createSeat({ floorId, payload: { code } }));
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
                value={buildingDraft.name}
                onChange={(event) => setBuildingDraft({ ...buildingDraft, name: event.target.value })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 5 }}>
              <TextField
                label="Address"
                fullWidth
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
                      value={floorDraft.level}
                      onChange={(event) => setFloorDraft({ ...floorDraft, level: event.target.value })}
                      sx={{ width: { sm: 120 } }}
                    />
                    <TextField
                      label="Floor name"
                      fullWidth
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
                    {isAdmin ? (
                      <Stack direction="row" spacing={1}>
                        <TextField
                          label="Seat code"
                          value={seatDrafts[floor.id] ?? ''}
                          onChange={(event) =>
                            setSeatDrafts({ ...seatDrafts, [floor.id]: event.target.value })
                          }
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
    </Box>
  );
}

/**
 * The equipment register: every physical unit in the estate, and its upkeep.
 *
 * Laid out like the facilities page it sits beside - buildings down the left,
 * their contents on the right - because it answers the same kind of question
 * about the same estate. Facilities says where people are; this says what is
 * there and when it was last looked at.
 *
 * Staff only. Reads are open to every persona in the API, because a reporter
 * has to be able to name the unit that failed, but browsing the register as a
 * whole is maintenance work.
 */

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
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
import ArchiveIcon from '@mui/icons-material/Archive';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import HandymanIcon from '@mui/icons-material/Handyman';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import EquipmentDialog from '../components/EquipmentDialog';
import { EMPTY_EQUIPMENT, equipmentPayload, serviceLabel } from '../components/equipmentDraft';
import { selectUser } from '../store/authSlice';
import { fetchBuildings, fetchFloors, fetchSeats, selectBuildings, selectFloors } from '../store/facilitiesSlice';
import { setFilters } from '../store/incidentsSlice';
import {
  createAsset,
  deleteAsset,
  fetchAssets,
  recordService,
  selectAssets,
  updateAsset,
} from '../store/maintenanceSlice';
import { notify } from '../store/uiSlice';
import { errorFields, errorMessage } from '../store/thunkUtils';
import { humanise } from '../theme';

/** Stable empty list, so the seat selector does not re-render the page. */
const NO_SEATS = [];

/**
 * Turn an asset row into its position, in words.
 *
 * @param {object} asset The asset.
 * @returns {string} For example `HQ North · Level 3 · 3A-12`.
 */
const placement = (asset) =>
  [
    asset.building_name,
    asset.floor_level === null || asset.floor_level === undefined ? null : `Level ${asset.floor_level}`,
    asset.seat_code,
  ]
    .filter(Boolean)
    .join(' · ') || 'Unplaced';

/**
 * Render the equipment page.
 *
 * @returns {JSX.Element} The equipment page.
 */
export default function EquipmentPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const user = useSelector(selectUser);
  const assets = useSelector(selectAssets);
  const buildings = useSelector(selectBuildings);
  const floors = useSelector(selectFloors);
  const { assetsStatus, saving } = useSelector((state) => state.maintenance);

  const [buildingId, setBuildingId] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  // `null` when closed; otherwise the unit being edited, or `{}` for a new one.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(EMPTY_EQUIPMENT);
  const [fieldErrors, setFieldErrors] = useState({});

  const isAdmin = user?.role === 'facility_admin';
  const seats = useSelector((state) => state.facilities.seatsByFloor[draft.floor_id] ?? NO_SEATS);

  useEffect(() => {
    dispatch(fetchBuildings());
  }, [dispatch]);

  useEffect(() => {
    dispatch(
      fetchAssets({
        building_id: buildingId || undefined,
        q: search.trim() || undefined,
        asset_type: typeFilter || undefined,
        include_retired: includeRetired || undefined,
        limit: 500,
      }),
    );
  }, [dispatch, buildingId, search, typeFilter, includeRetired]);

  useEffect(() => {
    if (draft.building_id) dispatch(fetchFloors(draft.building_id));
  }, [dispatch, draft.building_id]);

  useEffect(() => {
    if (draft.floor_id) dispatch(fetchSeats(draft.floor_id));
  }, [dispatch, draft.floor_id]);

  // The classes actually present, so the filter offers what exists rather than
  // a taxonomy the estate may not follow.
  const types = useMemo(
    () => [...new Set(assets.map((asset) => asset.asset_type))].sort(),
    [assets],
  );

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

  /** Reload the register with the filters currently applied. */
  const refresh = () =>
    dispatch(
      fetchAssets({
        building_id: buildingId || undefined,
        q: search.trim() || undefined,
        asset_type: typeFilter || undefined,
        include_retired: includeRetired || undefined,
        limit: 500,
      }),
    );

  /** Open the dialog for a new unit. */
  const openNew = () => {
    setEditing({});
    setDraft({ ...EMPTY_EQUIPMENT, building_id: buildingId || '' });
  };

  /**
   * Open the dialog against an existing unit.
   *
   * @param {object} asset The unit to edit.
   */
  const openEdit = (asset) => {
    setEditing(asset);
    setDraft({
      code: asset.code ?? '',
      name: asset.name ?? '',
      asset_type: asset.asset_type ?? '',
      manufacturer: asset.manufacturer ?? '',
      model: asset.model ?? '',
      building_id: asset.building_id ?? '',
      floor_id: asset.floor_id ?? '',
      seat_id: asset.seat_id ?? '',
      installed_on: asset.installed_on ?? '',
      expected_life_months: asset.expected_life_months ?? '',
      service_interval_months: asset.service_interval_months ?? '',
      last_serviced_on: asset.last_serviced_on ?? '',
    });
  };

  /** Create or update, depending on how the dialog was opened. */
  const submit = async () => {
    const payload = equipmentPayload(draft);
    const result = editing?.id
      ? await dispatch(updateAsset({ id: editing.id, payload }))
      : await dispatch(createAsset(payload));
    if (report(result, editing?.id ? 'Equipment updated' : 'Equipment registered')) {
      setEditing(null);
      setDraft(EMPTY_EQUIPMENT);
      refresh();
    }
  };

  /**
   * Record a service, moving the unit's next due date forward.
   *
   * @param {object} asset The unit that was serviced.
   */
  const markServiced = async (asset) => {
    const result = await dispatch(
      recordService({ id: asset.id, note: 'Recorded from the equipment register' }),
    );
    if (report(result, `${asset.code} marked as serviced`)) refresh();
  };

  /**
   * Take a unit out of service, keeping its history.
   *
   * @param {object} asset The unit to retire.
   */
  const retire = async (asset) => {
    const result = await dispatch(
      updateAsset({ id: asset.id, payload: { retired_on: new Date().toISOString().slice(0, 10) } }),
    );
    if (report(result, `${asset.code} retired`)) refresh();
  };

  /**
   * Remove a unit from the register. Its incidents keep their history.
   *
   * @param {object} asset The unit to remove.
   */
  const remove = async (asset) => {
    if (!window.confirm(`Remove ${asset.code} from the register? Its incidents are kept.`)) return;
    const result = await dispatch(deleteAsset(asset.id));
    if (report(result, `${asset.code} removed`)) refresh();
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

  return (
    <Box sx={{ py: 3 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 3 }}
        spacing={1}
      >
        <Box>
          <Typography variant="h1">Equipment</Typography>
          <Typography variant="body2" color="text.secondary">
            Every unit in the estate, where it sits and when it was last serviced. Incidents filed
            against a unit are what the maintenance figures are built from.
          </Typography>
        </Box>
        {isAdmin ? (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openNew}>
            Register equipment
          </Button>
        ) : null}
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 2 }}>
          <Paper variant="outlined">
            <Typography variant="h3" sx={{ p: 2, pb: 1 }}>
              Buildings
            </Typography>
            <List dense>
              <ListItem disablePadding>
                <ListItemButton selected={buildingId === ''} onClick={() => setBuildingId('')}>
                  <ListItemText primary="All buildings" />
                </ListItemButton>
              </ListItem>
              {buildings.map((building) => (
                <ListItem key={building.id} disablePadding>
                  <ListItemButton
                    selected={buildingId === building.id}
                    onClick={() => setBuildingId(building.id)}
                  >
                    <ListItemText primary={building.name} secondary={building.address ?? undefined} />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 10 }}>
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Search"
                fullWidth
                size="small"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                helperText="Asset tag, name or model"
              />
              <TextField
                select
                label="Class"
                size="small"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                sx={{ minWidth: 200 }}
                helperText=" "
              >
                <MenuItem value="">Every class</MenuItem>
                {types.map((type) => (
                  <MenuItem key={type} value={type}>
                    {humanise(type)}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="Retired"
                size="small"
                value={includeRetired ? 'yes' : 'no'}
                onChange={(event) => setIncludeRetired(event.target.value === 'yes')}
                sx={{ minWidth: 180 }}
                helperText=" "
              >
                <MenuItem value="no">In service only</MenuItem>
                <MenuItem value="yes">Include retired</MenuItem>
              </TextField>
            </Stack>
          </Paper>

          {assetsStatus === 'loading' && assets.length === 0 ? (
            <LinearProgress aria-label="Loading the equipment register" sx={{ mb: 2 }} />
          ) : null}

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="h3" gutterBottom>
              {assets.length} {assets.length === 1 ? 'unit' : 'units'}
            </Typography>
            {assets.length === 0 ? (
              <Alert severity="info">
                No equipment matches. Until units are registered, an incident can only say where a
                fault happened, not what failed.
              </Alert>
            ) : (
              <TableContainer>
                <Table size="small" aria-label="Equipment register">
                  <TableHead>
                    <TableRow>
                      <TableCell>Unit</TableCell>
                      <TableCell>Location</TableCell>
                      <TableCell>Next service</TableCell>
                      <TableCell align="right">Failures</TableCell>
                      {isAdmin ? <TableCell align="right">Actions</TableCell> : null}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {assets.map((asset) => (
                      <TableRow key={asset.id} hover>
                        <TableCell sx={{ maxWidth: 200 }}>
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                              {asset.code}
                            </Typography>
                            {asset.is_retired ? <Chip size="small" label="Retired" /> : null}
                          </Stack>
                          {/* Make and model are detail, not identity: truncated
                              on one line, with the whole string on hover and
                              available to a screen reader. */}
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            noWrap
                            sx={{ display: 'block' }}
                            title={[humanise(asset.asset_type), asset.name, asset.manufacturer, asset.model]
                              .filter(Boolean)
                              .join(' · ')}
                          >
                            {[humanise(asset.asset_type), asset.name, asset.manufacturer, asset.model]
                              .filter(Boolean)
                              .join(' · ')}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ maxWidth: 230 }}>
                          <Typography variant="body2" noWrap title={placement(asset)}>
                            {placement(asset)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            variant="outlined"
                            label={serviceLabel(asset)}
                            color={
                              asset.service_status === 'overdue'
                                ? 'error'
                                : asset.service_status === 'due_soon'
                                  ? 'warning'
                                  : 'default'
                            }
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Button size="small" onClick={() => showIncidents(asset.id)}>
                            {asset.incident_count}
                          </Button>
                        </TableCell>
                        {isAdmin ? (
                          <TableCell align="right">
                            <Stack direction="row" spacing={0} sx={{ justifyContent: 'flex-end' }}>
                              {/* Each wrapped in a span: MUI cannot attach a
                                  tooltip to a disabled button, and these are
                                  disabled often enough to matter. */}
                              <Tooltip
                                title={
                                  asset.service_interval_months
                                    ? `Record a service for ${asset.code}`
                                    : 'Set a service interval first'
                                }
                              >
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label={`Record a service for ${asset.code}`}
                                    onClick={() => markServiced(asset)}
                                    disabled={saving || !asset.service_interval_months}
                                  >
                                    <HandymanIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title={`Retire ${asset.code}`}>
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label={`Retire ${asset.code}`}
                                    onClick={() => retire(asset)}
                                    disabled={saving || asset.is_retired}
                                  >
                                    <ArchiveIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title={`Edit ${asset.code}`}>
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label={`Edit ${asset.code}`}
                                    onClick={() => openEdit(asset)}
                                    disabled={saving}
                                  >
                                    <EditIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title={`Remove ${asset.code}`}>
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label={`Remove ${asset.code}`}
                                    onClick={() => remove(asset)}
                                    disabled={saving}
                                  >
                                    <DeleteIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            </Stack>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>
      </Grid>

      <EquipmentDialog
        open={editing !== null}
        title={editing?.id ? `Edit ${editing.code}` : 'Register equipment'}
        draft={draft}
        onChange={setDraft}
        onSubmit={submit}
        onClose={() => setEditing(null)}
        fieldErrors={fieldErrors}
        saving={saving}
        buildings={buildings}
        floors={floors}
        seats={seats}
      />
    </Box>
  );
}

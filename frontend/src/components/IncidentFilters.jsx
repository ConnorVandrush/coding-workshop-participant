/**
 * Search and filter bar for the incident list.
 *
 * Filter values live in the Redux store, so the controls here are fully
 * controlled and the list page simply re-fetches whenever they change.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import SearchIcon from '@mui/icons-material/Search';
import PropTypes from 'prop-types';
import { CATEGORIES, PRIORITY_META, STATUS_META, humanise } from '../theme';

/**
 * Render the incident search and filter controls.
 *
 * @param {object} props Component props.
 * @param {object} props.filters Current filter values.
 * @param {Function} props.onChange Called with a partial filter update.
 * @param {Function} props.onReset Called to clear every filter.
 * @param {Array} props.buildings Buildings available for the location filter.
 * @returns {JSX.Element} The filter bar.
 */
export default function IncidentFilters({ filters, onChange, onReset, buildings }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <TextField
            fullWidth
            label="Search"
            placeholder="Title or description"
            value={filters.q}
            onChange={(event) => onChange({ q: event.target.value })}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <TextField
            select
            fullWidth
            label="Status"
            value={filters.status}
            onChange={(event) => onChange({ status: event.target.value })}
          >
            <MenuItem value="">All statuses</MenuItem>
            {Object.entries(STATUS_META).map(([value, meta]) => (
              <MenuItem key={value} value={value}>
                {meta.label}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <TextField
            select
            fullWidth
            label="Priority"
            value={filters.priority}
            onChange={(event) => onChange({ priority: event.target.value })}
          >
            <MenuItem value="">All priorities</MenuItem>
            {Object.entries(PRIORITY_META).map(([value, meta]) => (
              <MenuItem key={value} value={value}>
                {meta.label}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <TextField
            select
            fullWidth
            label="Category"
            value={filters.category}
            onChange={(event) => onChange({ category: event.target.value })}
          >
            <MenuItem value="">All categories</MenuItem>
            {CATEGORIES.map((value) => (
              <MenuItem key={value} value={value}>
                {humanise(value)}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <TextField
            select
            fullWidth
            label="Building"
            value={filters.building_id}
            onChange={(event) => onChange({ building_id: event.target.value })}
          >
            <MenuItem value="">All buildings</MenuItem>
            {buildings.map((building) => (
              <MenuItem key={building.id} value={building.id}>
                {building.name}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 12, md: 3 }}>
          <TextField
            select
            fullWidth
            label="Sort by"
            value={`${filters.sort}:${filters.order}`}
            onChange={(event) => {
              const [sort, order] = event.target.value.split(':');
              onChange({ sort, order });
            }}
          >
            <MenuItem value="created_at:desc">Newest first</MenuItem>
            <MenuItem value="created_at:asc">Oldest first</MenuItem>
            <MenuItem value="updated_at:desc">Recently updated</MenuItem>
            <MenuItem value="priority:desc">Highest priority</MenuItem>
            <MenuItem value="status:asc">Status</MenuItem>
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <TextField
            select
            fullWidth
            label="Flags"
            value={filters.is_escalated === 'true' ? 'escalated' : filters.unassigned === 'true' ? 'unassigned' : ''}
            onChange={(event) => {
              const choice = event.target.value;
              onChange({
                is_escalated: choice === 'escalated' ? 'true' : '',
                unassigned: choice === 'unassigned' ? 'true' : '',
              });
            }}
          >
            <MenuItem value="">No flag filter</MenuItem>
            <MenuItem value="escalated">Escalated only</MenuItem>
            <MenuItem value="unassigned">Unassigned only</MenuItem>
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, md: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', height: '100%' }}>
            <Button onClick={onReset} fullWidth>
              Clear filters
            </Button>
          </Box>
        </Grid>
      </Grid>
    </Paper>
  );
}

IncidentFilters.propTypes = {
  filters: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onReset: PropTypes.func.isRequired,
  buildings: PropTypes.arrayOf(PropTypes.object).isRequired,
};

/**
 * Account administration, restricted to facility admins.
 *
 * The API refuses to demote or deactivate the last active admin and refuses
 * self-deactivation; those errors surface as toasts rather than being
 * pre-empted here, so the rule lives in exactly one place.
 */

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useMediaQuery } from 'react-responsive';
import { useDispatch, useSelector } from 'react-redux';
import { selectUser } from '../store/authSlice';
import { fetchUsers, selectUsers, updateUserRole, updateUserStatus } from '../store/engineersSlice';
import { notify } from '../store/uiSlice';
import { errorMessage } from '../store/thunkUtils';
import { ROLE_LABELS, formatDateTime } from '../theme';

/**
 * Render the account administration page.
 *
 * @returns {JSX.Element} The accounts page.
 */
export default function UsersPage() {
  const dispatch = useDispatch();
  const currentUser = useSelector(selectUser);
  const users = useSelector(selectUsers);
  const isDesktop = useMediaQuery({ minWidth: 900 });
  const [search, setSearch] = useState('');

  useEffect(() => {
    dispatch(fetchUsers());
  }, [dispatch]);

  /**
   * Report the outcome of a dispatched thunk as a toast.
   *
   * @param {object} result The dispatch result.
   * @param {string} successMessage Message shown when the call succeeded.
   */
  const report = (result, successMessage) => {
    const ok = result.meta.requestStatus === 'fulfilled';
    dispatch(
      notify({
        message: ok ? successMessage : errorMessage(result.payload, 'The request failed'),
        severity: ok ? 'success' : 'error',
      }),
    );
  };

  /**
   * Change an account's role.
   *
   * @param {object} account The account to change.
   * @param {string} role The new role.
   */
  const changeRole = async (account, role) => {
    report(await dispatch(updateUserRole({ id: account.id, role })), `${account.full_name} is now ${ROLE_LABELS[role]}`);
  };

  /**
   * Activate or deactivate an account.
   *
   * @param {object} account The account to change.
   * @param {boolean} isActive The new activation state.
   */
  const changeStatus = async (account, isActive) => {
    report(
      await dispatch(updateUserStatus({ id: account.id, isActive })),
      isActive ? `${account.full_name} reactivated` : `${account.full_name} deactivated`,
    );
  };

  const visible = users.filter(
    (account) =>
      account.full_name.toLowerCase().includes(search.toLowerCase()) ||
      account.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Box sx={{ py: 3 }}>
      <Typography variant="h1" gutterBottom>
        Accounts
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Promote people to engineer or facility admin, and deactivate leavers.
      </Typography>

      <TextField
        label="Search by name or email"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        sx={{ mb: 2, width: { xs: '100%', sm: 320 } }}
      />

      {!isDesktop ? (
        <Stack spacing={1.5}>
          {visible.map((account) => (
            <Paper key={account.id} variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2">{account.full_name}</Typography>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {account.email}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 1 }}>
                <TextField
                  select
                  label="Role"
                  value={account.role}
                  onChange={(event) => changeRole(account, event.target.value)}
                  sx={{ flexGrow: 1 }}
                >
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <MenuItem key={value} value={value}>
                      {label}
                    </MenuItem>
                  ))}
                </TextField>
                <Switch
                  checked={account.is_active}
                  onChange={(event) => changeStatus(account, event.target.checked)}
                  slotProps={{ input: { 'aria-label': `Active state for ${account.full_name}` } }}
                />
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Registered</TableCell>
                <TableCell align="center">Active</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((account) => (
                <TableRow key={account.id} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      {account.full_name}
                      {account.id === currentUser?.id ? <Chip size="small" label="You" /> : null}
                    </Stack>
                  </TableCell>
                  <TableCell>{account.email}</TableCell>
                  <TableCell>
                    {/* The mobile card carries a visible "Role" label; this
                        one sits under a column header, which is not associated
                        with a combobox by any assistive technology. Without a
                        name it was announced as just "combobox, Employee".
                        Naming the account as well as the field means a screen
                        reader user moving down the column always knows whose
                        role they are about to change. */}
                    <TextField
                      select
                      value={account.role}
                      onChange={(event) => changeRole(account, event.target.value)}
                      slotProps={{ input: { 'aria-label': `Role for ${account.full_name}` } }}
                      sx={{ minWidth: 160 }}
                    >
                      {Object.entries(ROLE_LABELS).map(([value, label]) => (
                        <MenuItem key={value} value={value}>
                          {label}
                        </MenuItem>
                      ))}
                    </TextField>
                  </TableCell>
                  <TableCell>{formatDateTime(account.created_at)}</TableCell>
                  <TableCell align="center">
                    <Switch
                      checked={account.is_active}
                      onChange={(event) => changeStatus(account, event.target.checked)}
                      slotProps={{ input: { 'aria-label': `Active state for ${account.full_name}` } }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

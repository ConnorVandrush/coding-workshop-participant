/**
 * Responsive application shell.
 *
 * Desktop gets a permanent sidebar; phones and tablets get a temporary drawer
 * behind a hamburger button. The breakpoint is evaluated with React Responsive
 * so the same query can drive both the layout here and the table/card switch on
 * the incident list.
 */

import { useMemo } from 'react';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ApartmentIcon from '@mui/icons-material/Apartment';
import ConfirmationNumberIcon from '@mui/icons-material/ConfirmationNumber';
import DashboardIcon from '@mui/icons-material/Dashboard';
import EngineeringIcon from '@mui/icons-material/Engineering';
import GroupIcon from '@mui/icons-material/Group';
import LogoutIcon from '@mui/icons-material/Logout';
import MenuIcon from '@mui/icons-material/Menu';
import PropTypes from 'prop-types';
import { useMediaQuery } from 'react-responsive';
import { useDispatch, useSelector } from 'react-redux';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';
import NotificationBell from './NotificationBell';
import Notifier from './Notifier';
import OfflineBanner from './OfflineBanner';
import { selectUser, signOut } from '../store/authSlice';
import { selectDrawerOpen, setDrawerOpen } from '../store/uiSlice';
import { ROLE_LABELS } from '../theme';

const DRAWER_WIDTH = 236;

// `roles` empty means the entry is visible to every signed-in persona.
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon, roles: [] },
  { to: '/incidents', label: 'Incidents', icon: ConfirmationNumberIcon, roles: [] },
  { to: '/facilities', label: 'Facilities', icon: ApartmentIcon, roles: [] },
  { to: '/engineers', label: 'Engineers', icon: EngineeringIcon, roles: [] },
  { to: '/users', label: 'Accounts', icon: GroupIcon, roles: ['facility_admin'] },
];

/**
 * Render the navigation shell around the routed page.
 *
 * @param {object} props Component props.
 * @param {React.ReactNode} props.children The routed page content.
 * @returns {JSX.Element} The application shell.
 */
export default function AppLayout({ children }) {
  const user = useSelector(selectUser);
  const drawerOpen = useSelector(selectDrawerOpen);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const isDesktop = useMediaQuery({ minWidth: 900 });

  const items = useMemo(
    () => NAV_ITEMS.filter((item) => item.roles.length === 0 || item.roles.includes(user?.role)),
    [user?.role],
  );

  /** Sign out and return to the login screen. */
  const handleLogout = async () => {
    // Revokes the refresh token server-side, so the session cannot be resumed
    // from a copy of it elsewhere.
    await dispatch(signOut());
    navigate('/login', { replace: true });
  };

  const navigation = (
    <Box role="navigation" aria-label="Main">
      <Toolbar sx={{ px: 2 }}>
        <Typography variant="h3" noWrap sx={{ fontWeight: 700 }}>
          ACME Facilities
        </Typography>
      </Toolbar>
      <Divider />
      <List>
        {items.map((item) => {
          const Icon = item.icon;
          const selected =
            item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
          return (
            <ListItemButton
              key={item.to}
              component={RouterLink}
              to={item.to}
              selected={selected}
              onClick={() => dispatch(setDrawerOpen(false))}
            >
              <ListItemIcon sx={{ minWidth: 40 }}>
                <Icon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={item.label} />
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          zIndex: (theme) => theme.zIndex.drawer + 1,
        }}
      >
        <Toolbar>
          {!isDesktop ? (
            <IconButton
              edge="start"
              onClick={() => dispatch(setDrawerOpen(!drawerOpen))}
              aria-label="Open navigation"
              sx={{ mr: 1 }}
            >
              <MenuIcon />
            </IconButton>
          ) : null}
          <Typography variant="h3" sx={{ flexGrow: 1 }} noWrap>
            {isDesktop ? 'Facility Incident Management' : 'ACME Facilities'}
          </Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <NotificationBell />
            {user ? (
              <>
                {isDesktop ? (
                  <Chip size="small" label={ROLE_LABELS[user.role] ?? user.role} color="primary" />
                ) : null}
                <Tooltip title={`${user.full_name} (${user.email})`}>
                  <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                    {user.full_name
                      .split(' ')
                      .map((part) => part[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </Avatar>
                </Tooltip>
              </>
            ) : null}
            <Tooltip title="Sign out">
              <IconButton onClick={handleLogout} aria-label="Sign out">
                <LogoutIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant={isDesktop ? 'permanent' : 'temporary'}
          open={isDesktop ? true : drawerOpen}
          onClose={() => dispatch(setDrawerOpen(false))}
          ModalProps={{ keepMounted: true }}
          sx={{
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: 'divider',
            },
          }}
        >
          {navigation}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          px: { xs: 2, sm: 3 },
          pb: 5,
        }}
      >
        <Toolbar />
        <OfflineBanner />
        {children}
        <Notifier />
      </Box>
    </Box>
  );
}

AppLayout.propTypes = {
  children: PropTypes.node.isRequired,
};

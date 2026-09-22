/**
 * The notification bell in the app bar.
 *
 * Notifications are written asynchronously by the worker, so the badge is kept
 * current by the same polling the rest of the live data uses rather than by a
 * push. Opening an entry marks it read and navigates to the incident it is
 * about, which is the only thing anyone wants to do with one.
 */

import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import usePolling from '../hooks/usePolling';
import {
  fetchNotifications,
  markAllRead,
  markRead,
  selectNotifications,
  selectUnreadCount,
} from '../store/notificationsSlice';
import { formatDateTime } from '../theme';

/**
 * Render the bell, its badge and the feed popover.
 *
 * @returns {JSX.Element} The notification control.
 */
export default function NotificationBell() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const items = useSelector(selectNotifications);
  const unread = useSelector(selectUnreadCount);
  const [anchorEl, setAnchorEl] = useState(null);

  const refresh = useCallback(() => dispatch(fetchNotifications()), [dispatch]);

  // Load once on mount as well as on the poll: otherwise the badge stays empty
  // for a whole interval after signing in, which reads as "no notifications".
  useEffect(() => {
    refresh();
  }, [refresh]);

  usePolling(refresh);

  /** Load the feed as the popover opens, so it is never stale on screen. */
  const open = (event) => {
    setAnchorEl(event.currentTarget);
    refresh();
  };

  /**
   * Mark an entry read and go to the incident it concerns.
   *
   * @param {object} notification The notification that was clicked.
   */
  const follow = (notification) => {
    if (!notification.is_read) dispatch(markRead(notification.id));
    setAnchorEl(null);
    if (notification.incident_id) navigate(`/incidents/${notification.incident_id}`);
  };

  return (
    <>
      <Tooltip title={unread ? `${unread} unread notifications` : 'Notifications'}>
        <IconButton
          onClick={open}
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Badge badgeContent={unread} color="error" max={99}>
            <NotificationsIcon />
          </Badge>
        </IconButton>
      </Tooltip>

      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 360, maxWidth: '100vw' } } }}
      >
        <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h3" sx={{ flexGrow: 1 }}>
            Notifications
          </Typography>
          {unread > 0 ? (
            <Button size="small" onClick={() => dispatch(markAllRead())}>
              Mark all read
            </Button>
          ) : null}
        </Box>
        <Divider />

        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>
            Nothing yet. You will hear about incidents you report or are assigned.
          </Typography>
        ) : (
          <List dense sx={{ maxHeight: 400, overflowY: 'auto', py: 0 }}>
            {items.map((notification) => (
              <ListItemButton
                key={notification.id}
                onClick={() => follow(notification)}
                sx={{ bgcolor: notification.is_read ? 'inherit' : 'action.hover' }}
              >
                <ListItemText
                  primary={notification.body}
                  secondary={formatDateTime(notification.created_at)}
                  slotProps={{
                    primary: { variant: 'body2', fontWeight: notification.is_read ? 400 : 600 },
                    secondary: { variant: 'caption' },
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  );
}

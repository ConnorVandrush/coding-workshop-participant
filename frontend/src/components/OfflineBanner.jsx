/**
 * Tells the user when the browser has lost its connection.
 *
 * Installed as an app, this is reachable with no network at all: the shell is
 * precached, so it opens and renders. Nothing it shows is usable, though,
 * because incident data is live and deliberately never cached. Saying so
 * plainly is better than letting every request fail one by one into a toast.
 */

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CloudOffIcon from '@mui/icons-material/CloudOff';

/**
 * Render a banner while the browser reports itself offline.
 *
 * @returns {JSX.Element|null} The banner, or null when online.
 */
export default function OfflineBanner() {
  // navigator.onLine can be absent in a test environment, so default to online:
  // wrongly claiming to be offline is worse than missing a real outage.
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <Box sx={{ position: 'sticky', top: 0, zIndex: (theme) => theme.zIndex.appBar + 1 }}>
      <Alert severity="warning" icon={<CloudOffIcon />} square role="status">
        You are offline. Incident data is live, so nothing here will update until the
        connection returns.
      </Alert>
    </Box>
  );
}

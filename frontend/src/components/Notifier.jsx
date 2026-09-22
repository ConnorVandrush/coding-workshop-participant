/**
 * Global toast host, bound to the `ui` slice.
 *
 * Mounted once in the layout so that any thunk can report success or failure
 * through `notify()` without the calling component owning a snackbar.
 */

import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import { useDispatch, useSelector } from 'react-redux';
import { dismissToast, selectToast } from '../store/uiSlice';

/**
 * Render the application-wide toast.
 *
 * @returns {JSX.Element|null} The snackbar, or null when nothing is queued.
 */
export default function Notifier() {
  const toast = useSelector(selectToast);
  const dispatch = useDispatch();

  if (!toast) return null;

  return (
    <Snackbar
      key={toast.key}
      open
      autoHideDuration={toast.severity === 'error' ? 8000 : 4000}
      onClose={() => dispatch(dismissToast())}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert
        severity={toast.severity}
        variant="filled"
        onClose={() => dispatch(dismissToast())}
        sx={{ width: '100%' }}
      >
        {toast.message}
      </Alert>
    </Snackbar>
  );
}

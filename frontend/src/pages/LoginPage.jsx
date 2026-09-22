/**
 * Sign-in and registration.
 *
 * Both live on one page behind a tab switch: the flows share a layout and
 * differ by one field, and a workshop reviewer should be able to create an
 * account without hunting for a second route.
 */

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useDispatch, useSelector } from 'react-redux';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { clearAuthError, login, register, selectToken } from '../store/authSlice';

/**
 * Render the authentication page.
 *
 * @returns {JSX.Element} The sign-in / register card.
 */
export default function LoginPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const token = useSelector(selectToken);
  const { status, error } = useSelector((state) => state.auth);

  const [tab, setTab] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');

  const isRegister = tab === 1;
  const busy = status === 'loading';

  useEffect(() => {
    dispatch(clearAuthError());
  }, [dispatch, tab]);

  if (token) return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;

  /**
   * Submit the form as either a sign-in or a registration.
   *
   * @param {React.FormEvent} event The submit event.
   */
  const handleSubmit = async (event) => {
    event.preventDefault();
    const action = isRegister
      ? register({ email, fullName, password })
      : login({ email, password });
    const result = await dispatch(action);
    if (result.meta.requestStatus === 'fulfilled') navigate('/', { replace: true });
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 440 }} variant="outlined">
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Typography variant="h1" gutterBottom>
            ACME Facilities
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Report and track facility and workplace technology incidents.
          </Typography>

          <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ mb: 3 }}>
            <Tab label="Sign in" />
            <Tab label="Register" />
          </Tabs>

          <Box component="form" onSubmit={handleSubmit} noValidate>
            <Stack spacing={2}>
              {isRegister ? (
                <TextField
                  label="Full name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  required
                  fullWidth
                  autoComplete="name"
                />
              ) : null}
              <TextField
                label="Work email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                fullWidth
                autoComplete="email"
                helperText={isRegister ? 'Must be an @acme.inc address' : ' '}
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                fullWidth
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                helperText={isRegister ? 'At least 8 characters' : ' '}
              />

              {error ? <Alert severity="error">{error}</Alert> : null}

              <Button type="submit" variant="contained" size="large" disabled={busy} fullWidth>
                {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
              </Button>
            </Stack>
          </Box>

          <Alert severity="info" sx={{ mt: 3 }}>
            <Typography variant="caption" component="div" sx={{ fontWeight: 600 }}>
              Demo accounts (password: Workshop#2026)
            </Typography>
            <Typography variant="caption" component="div">
              admin@acme.inc · sam.okafor@acme.inc · dana.ruiz@acme.inc
            </Typography>
          </Alert>
        </CardContent>
      </Card>
    </Box>
  );
}

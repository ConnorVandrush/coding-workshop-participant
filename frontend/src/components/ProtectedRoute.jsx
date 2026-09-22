/**
 * Route guard enforcing authentication and, optionally, role membership.
 *
 * This is a usability layer, not the security boundary: the API independently
 * rejects anything the caller's role does not permit. Guarding here simply
 * avoids showing pages that would only produce 403s.
 */

import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import PropTypes from 'prop-types';
import { Navigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectAuthReady, selectRole, selectToken } from '../store/authSlice';

/**
 * Render children only for an authenticated user holding an allowed role.
 *
 * @param {object} props Component props.
 * @param {React.ReactNode} props.children The protected content.
 * @param {string[]} [props.roles] Roles allowed through; empty means any.
 * @returns {JSX.Element} The children, a redirect, or a loading indicator.
 */
export default function ProtectedRoute({ children, roles = [] }) {
  const token = useSelector(selectToken);
  const role = useSelector(selectRole);
  const ready = useSelector(selectAuthReady);
  const location = useLocation();

  if (!token) return <Navigate to="/login" replace state={{ from: location }} />;

  // Wait for the stored token to be validated before deciding on the role.
  if (!ready) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (roles.length > 0 && !roles.includes(role)) return <Navigate to="/" replace />;

  return children;
}

ProtectedRoute.propTypes = {
  children: PropTypes.node.isRequired,
  roles: PropTypes.arrayOf(PropTypes.string),
};

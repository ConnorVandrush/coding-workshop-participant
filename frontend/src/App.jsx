/**
 * Route table.
 *
 * Every application route is wrapped in `ProtectedRoute`, which redirects
 * anonymous visitors to the login page and keeps admin-only pages out of reach
 * of the other personas.
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import AppLayout from './components/AppLayout';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardPage from './pages/DashboardPage';
import EngineersPage from './pages/EngineersPage';
import FacilitiesPage from './pages/FacilitiesPage';
import IncidentDetailPage from './pages/IncidentDetailPage';
import IncidentsPage from './pages/IncidentsPage';
import LoginPage from './pages/LoginPage';
import UsersPage from './pages/UsersPage';
import { loadSession, selectToken } from './store/authSlice';

/**
 * Application root: validates any restored session, then renders the routes.
 *
 * @returns {JSX.Element} The routed application.
 */
export default function App() {
  const dispatch = useDispatch();
  const token = useSelector(selectToken);

  // A token restored from localStorage may have expired while the tab was
  // closed, so it is validated once at startup before any page renders.
  useEffect(() => {
    if (token) dispatch(loadSession());
  }, [dispatch, token]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/incidents" element={<IncidentsPage />} />
                <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
                <Route path="/facilities" element={<FacilitiesPage />} />
                <Route path="/engineers" element={<EngineersPage />} />
                <Route
                  path="/users"
                  element={
                    <ProtectedRoute roles={['facility_admin']}>
                      <UsersPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

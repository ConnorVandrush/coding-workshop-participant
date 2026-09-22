/**
 * Visual representation of the incident workflow.
 *
 * The graph is fetched from `GET /workflow` rather than hard-coded, so the
 * diagram cannot drift from the transitions the backend actually enforces.
 * When an incident is supplied, its current state is highlighted and the
 * transitions still available to it are drawn in colour.
 */

import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import PropTypes from 'prop-types';
import { useMediaQuery } from 'react-responsive';
import { STATUS_META } from '../theme';

// Left-to-right reading order of the lifecycle; CLOSED is terminal.
const LANE = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED'];

/**
 * Render the incident lifecycle as a diagram.
 *
 * @param {object} props Component props.
 * @param {object|null} props.workflow The `{statuses, transitions}` graph.
 * @param {string} [props.currentStatus] Status to highlight as "you are here".
 * @param {string[]} [props.allowedTransitions] Statuses reachable right now.
 * @returns {JSX.Element} The workflow diagram.
 */
export default function WorkflowDiagram({ workflow, currentStatus = '', allowedTransitions = [] }) {
  // Stack the lane vertically on phones so the nodes stay legible.
  const isNarrow = useMediaQuery({ maxWidth: 899 });

  const statuses = workflow?.statuses ?? LANE.map((id) => ({ id, label: STATUS_META[id].label }));
  const ordered = LANE.filter((id) => statuses.some((status) => status.id === id));
  const transitions = workflow?.transitions ?? [];

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h3" gutterBottom>
        Ticket workflow
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {currentStatus
          ? 'Highlighted is the current state; coloured arrows are the moves available now.'
          : 'The lifecycle every incident follows, as enforced by the API.'}
      </Typography>

      <Stack
        direction={isNarrow ? 'column' : 'row'}
        spacing={1}
       
        sx={{ alignItems: isNarrow ? 'stretch' : 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        {ordered.map((id, index) => {
          const isCurrent = id === currentStatus;
          const isReachable = allowedTransitions.includes(id);
          const meta = STATUS_META[id] ?? { label: id, color: 'default' };
          return (
            <Stack
              key={id}
              direction={isNarrow ? 'column' : 'row'}
              spacing={1}
             
              sx={{ alignItems: "center", flexShrink: 0 }}
            >
              <Box
                sx={{
                  px: 2,
                  py: 1,
                  minWidth: 118,
                  textAlign: 'center',
                  borderRadius: 2,
                  border: 2,
                  borderColor: isCurrent
                    ? `${meta.color === 'default' ? 'grey' : meta.color}.main`
                    : 'divider',
                  bgcolor: isCurrent
                    ? `${meta.color === 'default' ? 'grey' : meta.color}.main`
                    : 'background.paper',
                  color: isCurrent ? 'common.white' : 'text.primary',
                  fontWeight: isCurrent ? 700 : 500,
                  opacity: currentStatus && !isCurrent && !isReachable ? 0.45 : 1,
                }}
              >
                <Typography variant="body2" component="span" sx={{ fontWeight: 'inherit' }}>
                  {meta.label}
                </Typography>
                {isReachable ? (
                  <Typography variant="caption" component="div" color="success.main">
                    available
                  </Typography>
                ) : null}
              </Box>
              {index < ordered.length - 1 ? (
                <ArrowForwardIcon
                  fontSize="small"
                  sx={{
                    color: 'text.disabled',
                    transform: isNarrow ? 'rotate(90deg)' : 'none',
                  }}
                />
              ) : null}
            </Stack>
          );
        })}
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        {transitions.length} transitions defined. Incidents can also move backwards — a resolved
        ticket reopens to In Progress, and a closed one can be reopened by a facility admin.
      </Typography>
    </Paper>
  );
}

WorkflowDiagram.propTypes = {
  workflow: PropTypes.shape({
    statuses: PropTypes.arrayOf(PropTypes.object),
    transitions: PropTypes.arrayOf(PropTypes.object),
  }),
  currentStatus: PropTypes.string,
  allowedTransitions: PropTypes.arrayOf(PropTypes.string),
};

/**
 * The duplicate-suggestion panel.
 *
 * The behaviour worth protecting here is mostly about restraint: the panel
 * stays out of the way when there is nothing to say, never renders a link the
 * caller cannot follow, and never claims more than the API told it.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { MemoryRouter } from 'react-router-dom';
import SimilarIncidents from './SimilarIncidents';
import theme from '../theme';

const MATCH = {
  id: 42,
  title: 'Projector will not power on in Meeting Room 3A',
  category: 'AV_EQUIPMENT',
  priority: 'HIGH',
  status: 'IN_PROGRESS',
  location: { building_id: 1, building_name: 'HQ North', floor_id: 10, floor_level: 3, seat_id: null, seat_code: null },
  created_at: '2026-09-21T09:12:00Z',
  score: 0.76,
  reasons: ['wording is very similar', 'same category', 'same floor'],
  visible: true,
};

/**
 * Render the panel inside the providers it needs.
 *
 * @param {object} props Props for the component under test.
 * @returns {object} Testing Library result.
 */
function renderPanel(props) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <SimilarIncidents {...props} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('SimilarIncidents', () => {
  it('renders nothing when there are no matches', () => {
    const { container } = renderPanel({ matches: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when matches are missing entirely', () => {
    const { container } = renderPanel({ matches: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the title, status, priority and place of each match', () => {
    renderPanel({ matches: [MATCH] });
    const panel = screen.getByTestId('similar-incidents');
    expect(within(panel).getByText(/#42 Projector will not power on/)).toBeInTheDocument();
    expect(within(panel).getByText('In Progress')).toBeInTheDocument();
    expect(within(panel).getByText('High')).toBeInTheDocument();
    expect(within(panel).getByText(/HQ North/)).toBeInTheDocument();
    expect(within(panel).getByText(/level 3/)).toBeInTheDocument();
  });

  it('explains why each match was suggested', () => {
    renderPanel({ matches: [MATCH] });
    expect(
      screen.getByText(/Matched because: wording is very similar, same category, same floor/),
    ).toBeInTheDocument();
  });

  it('links to a match the caller may open', () => {
    renderPanel({ matches: [MATCH] });
    expect(screen.getByRole('link', { name: /#42/ })).toHaveAttribute('href', '/incidents/42');
  });

  it('does not link to a match the caller cannot open', () => {
    renderPanel({ matches: [{ ...MATCH, visible: false }] });
    expect(screen.queryByRole('link', { name: /#42/ })).not.toBeInTheDocument();
    expect(screen.getByText(/#42 Projector will not power on/)).toBeInTheDocument();
    expect(screen.getByText(/Reported by someone else/)).toBeInTheDocument();
  });

  it('counts the matches in the heading, in the singular', () => {
    renderPanel({ matches: [MATCH] });
    expect(screen.getByText(/1 similar incident\b/)).toBeInTheDocument();
  });

  it('counts the matches in the heading, in the plural', () => {
    renderPanel({ matches: [MATCH, { ...MATCH, id: 43 }] });
    expect(screen.getByText(/2 similar incidents/)).toBeInTheDocument();
  });

  it('warns and explains what to do while a report is being drafted', () => {
    renderPanel({ matches: [MATCH], variant: 'draft' });
    expect(screen.getByText(/This may already be reported/)).toBeInTheDocument();
    expect(screen.getByText(/you can still report yours if it is different/)).toBeInTheDocument();
  });

  it('is informational rather than a warning on the detail view', () => {
    renderPanel({ matches: [MATCH], variant: 'detail' });
    // Nothing is being drafted there, so there is no advice to give.
    expect(screen.queryByText(/This may already be reported/)).not.toBeInTheDocument();
    expect(screen.queryByText(/you can still report yours/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 similar incident\b/)).toBeInTheDocument();
  });

  it('announces itself politely, because it updates while the user types', () => {
    renderPanel({ matches: [MATCH] });
    const panel = screen.getByTestId('similar-incidents');
    expect(panel).toHaveAttribute('aria-live', 'polite');
    expect(panel).toHaveAttribute('role', 'status');
  });

  it('omits the place when the match has no location', () => {
    renderPanel({ matches: [{ ...MATCH, location: null }] });
    expect(screen.getByText(/Av Equipment · reported/)).toBeInTheDocument();
  });

  it('names a seat when the match has one', () => {
    renderPanel({
      matches: [{ ...MATCH, location: { ...MATCH.location, seat_code: '3A-12' } }],
    });
    expect(screen.getByText(/3A-12/)).toBeInTheDocument();
  });

  it('shows a match on level 0 rather than treating it as missing', () => {
    // Guards the falsy check: `if (location.floor_level)` would silently drop a
    // ground floor numbered zero.
    renderPanel({
      matches: [{ ...MATCH, location: { ...MATCH.location, floor_level: 0 } }],
    });
    expect(screen.getByText(/level 0/)).toBeInTheDocument();
  });

  it('omits the reasons line when the API sent none', () => {
    renderPanel({ matches: [{ ...MATCH, reasons: [] }] });
    expect(screen.queryByText(/Matched because/)).not.toBeInTheDocument();
  });
});

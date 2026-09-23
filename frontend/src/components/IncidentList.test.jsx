/**
 * Tests for the incident list.
 *
 * The important behaviour here is the responsive switch: a data table is
 * unusable at phone width, so below the breakpoint the same fields must render
 * as cards. That is a behavioural regression a build would never catch, and it
 * is driven by React Responsive rather than CSS, so the hook is mocked to make
 * the breakpoint deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMediaQuery } from 'react-responsive';
import IncidentList from './IncidentList';

vi.mock('react-responsive', () => ({ useMediaQuery: vi.fn() }));

/**
 * Pin the viewport for a test.
 *
 * @param {boolean} desktop Whether the desktop media query should match.
 */
const setViewport = (desktop) => useMediaQuery.mockReturnValue(desktop);

const incidents = [
  {
    id: 42,
    title: 'Projector will not power on',
    category: 'AV_EQUIPMENT',
    priority: 'HIGH',
    status: 'IN_PROGRESS',
    is_escalated: true,
    assignee: { id: 3, full_name: 'Sam Okafor' },
    location: { building_name: 'HQ North', floor_level: 3, seat_code: '3A-12' },
    created_at: '2026-09-22T10:00:00Z',
  },
  {
    id: 43,
    title: 'AC leaking over desks',
    category: 'HVAC',
    priority: 'CRITICAL',
    status: 'BLOCKED',
    is_escalated: false,
    assignee: null,
    location: { building_name: 'HQ North', floor_level: 2, seat_code: null },
    created_at: '2026-09-22T11:00:00Z',
  },
];

describe('desktop', () => {
  it('renders a table with a row per incident', () => {
    setViewport(true);
    render(<IncidentList incidents={incidents} onSelect={() => {}} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(incidents.length + 1); // + header
  });

  it('shows the humanised category and the composed location', () => {
    setViewport(true);
    render(<IncidentList incidents={incidents} onSelect={() => {}} />);
    expect(screen.getByText('Av Equipment')).toBeInTheDocument();
    expect(screen.getByText('HQ North · L3 · 3A-12')).toBeInTheDocument();
  });

  it('falls back to an em dash for an unassigned incident', () => {
    setViewport(true);
    render(<IncidentList incidents={[incidents[1]]} onSelect={() => {}} />);
    // Two columns can be empty on this row - the assignee and the equipment -
    // so the count is asserted rather than a single match.
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('names the unit an incident was filed against', () => {
    setViewport(true);
    const withAsset = {
      ...incidents[0],
      asset: { id: 4, code: 'AV-3A-PROJ-01', name: 'Ceiling projector', asset_type: 'PROJECTOR' },
    };
    render(<IncidentList incidents={[withAsset]} onSelect={() => {}} />);
    const tag = screen.getByText('AV-3A-PROJ-01');
    // The tag is shown; the full name stays reachable on hover.
    expect(tag).toHaveAttribute('title', 'Ceiling projector');
  });

  it('calls onSelect with the incident id when a row is clicked', async () => {
    setViewport(true);
    const onSelect = vi.fn();
    render(<IncidentList incidents={incidents} onSelect={onSelect} />);
    await userEvent.click(screen.getByText('Projector will not power on'));
    expect(onSelect).toHaveBeenCalledWith(42);
  });
});

describe('phone', () => {
  it('drops the table in favour of cards', () => {
    setViewport(false);
    render(<IncidentList incidents={incidents} onSelect={() => {}} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/Projector will not power on/)).toBeInTheDocument();
  });

  it('still exposes status, priority and assignment', () => {
    setViewport(false);
    render(<IncidentList incidents={incidents} onSelect={() => {}} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText(/Unassigned/)).toBeInTheDocument();
  });

  it('remains clickable', async () => {
    setViewport(false);
    const onSelect = vi.fn();
    render(<IncidentList incidents={incidents} onSelect={onSelect} />);
    await userEvent.click(screen.getByText(/Projector will not power on/));
    expect(onSelect).toHaveBeenCalledWith(42);
  });
});

describe('empty state', () => {
  it.each([[true], [false]])('explains an empty result set (desktop=%s)', (desktop) => {
    setViewport(desktop);
    render(<IncidentList incidents={[]} onSelect={() => {}} />);
    expect(screen.getByText('No incidents match these filters.')).toBeInTheDocument();
  });
});

/**
 * Tests for the incident filter bar.
 *
 * Every control is fully controlled from the store, so what matters is that it
 * reports the right partial update. The flags control is the subtle one: it
 * maps a single dropdown onto two mutually exclusive query parameters, and
 * must clear whichever one is not chosen.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IncidentFilters from './IncidentFilters';
import { DEFAULT_FILTERS } from '../store/incidentsSlice';

const buildings = [
  { id: 1, name: 'HQ North' },
  { id: 2, name: 'Riverside Annex' },
];

/**
 * Render the bar with a spy for changes.
 *
 * @param {object} [filters] Filter values to seed.
 * @returns {object} The onChange and onReset spies.
 */
function renderFilters(filters = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <IncidentFilters
      filters={{ ...DEFAULT_FILTERS, ...filters }}
      buildings={buildings}
      onChange={onChange}
      onReset={onReset}
    />,
  );
  return { onChange, onReset };
}

/**
 * Pick an option from one of the select controls.
 *
 * @param {string} label The control's label.
 * @param {string} option The option to choose.
 */
async function choose(label, option) {
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('text search', () => {
  it('reports each keystroke so the list can narrow as you type', async () => {
    const { onChange } = renderFilters();
    await userEvent.type(screen.getByLabelText('Search'), 'ab');
    expect(onChange).toHaveBeenCalledWith({ q: 'a' });
    expect(onChange).toHaveBeenCalledWith({ q: 'b' });
  });
});

describe('enum filters', () => {
  it.each([
    ['Status', 'Blocked', { status: 'BLOCKED' }],
    ['Priority', 'Critical', { priority: 'CRITICAL' }],
    ['Category', 'Av Equipment', { category: 'AV_EQUIPMENT' }],
  ])('%s reports the API value, not the label', async (label, option, expected) => {
    const { onChange } = renderFilters();
    await choose(label, option);
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('offers an "all" choice that clears the filter', async () => {
    const { onChange } = renderFilters({ status: 'OPEN' });
    await choose('Status', 'All statuses');
    expect(onChange).toHaveBeenCalledWith({ status: '' });
  });

  it('lists the buildings it was given', async () => {
    const { onChange } = renderFilters();
    await choose('Building', 'Riverside Annex');
    expect(onChange).toHaveBeenCalledWith({ building_id: 2 });
  });
});

describe('sorting', () => {
  it('splits the combined choice into sort and order', async () => {
    const { onChange } = renderFilters();
    await choose('Sort by', 'Highest priority');
    expect(onChange).toHaveBeenCalledWith({ sort: 'priority', order: 'desc' });
  });

  it('can sort oldest first', async () => {
    const { onChange } = renderFilters();
    await choose('Sort by', 'Oldest first');
    expect(onChange).toHaveBeenCalledWith({ sort: 'created_at', order: 'asc' });
  });
});

describe('flags', () => {
  it('sets escalated and clears unassigned', async () => {
    // The two are mutually exclusive in the UI, so choosing one must clear the
    // other; otherwise both reach the API and the result set is wrong.
    const { onChange } = renderFilters({ unassigned: 'true' });
    await choose('Flags', 'Escalated only');
    expect(onChange).toHaveBeenCalledWith({ is_escalated: 'true', unassigned: '' });
  });

  it('sets unassigned and clears escalated', async () => {
    const { onChange } = renderFilters({ is_escalated: 'true' });
    await choose('Flags', 'Unassigned only');
    expect(onChange).toHaveBeenCalledWith({ is_escalated: '', unassigned: 'true' });
  });

  it('clears both when no flag filter is chosen', async () => {
    const { onChange } = renderFilters({ is_escalated: 'true' });
    await choose('Flags', 'No flag filter');
    expect(onChange).toHaveBeenCalledWith({ is_escalated: '', unassigned: '' });
  });

  it('shows which flag is active', () => {
    renderFilters({ unassigned: 'true' });
    expect(screen.getByLabelText('Flags')).toHaveTextContent('Unassigned only');
  });
});

describe('reset', () => {
  it('asks the page to clear every filter', async () => {
    const { onReset } = renderFilters({ q: 'projector', status: 'OPEN' });
    await userEvent.click(screen.getByRole('button', { name: /Clear filters/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

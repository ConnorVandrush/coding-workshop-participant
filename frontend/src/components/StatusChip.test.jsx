/**
 * Tests for the status, priority and escalation chips.
 *
 * These map API enum values onto the words a user reads, so a mismatch shows
 * wrong information rather than failing loudly.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EscalationChip, PriorityChip, StatusChip } from './StatusChip';

describe('StatusChip', () => {
  it.each([
    ['OPEN', 'Open'],
    ['IN_PROGRESS', 'In Progress'],
    ['BLOCKED', 'Blocked'],
    ['RESOLVED', 'Resolved'],
    ['CLOSED', 'Closed'],
  ])('renders %s as "%s"', (status, label) => {
    render(<StatusChip status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows an unrecognised status verbatim rather than blank', () => {
    render(<StatusChip status="CANCELLED" />);
    expect(screen.getByText('CANCELLED')).toBeInTheDocument();
  });
});

describe('PriorityChip', () => {
  it.each([
    ['LOW', 'Low'],
    ['MEDIUM', 'Medium'],
    ['HIGH', 'High'],
    ['CRITICAL', 'Critical'],
  ])('renders %s as "%s"', (priority, label) => {
    render(<PriorityChip priority={priority} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('EscalationChip', () => {
  it('renders nothing when the incident is not escalated', () => {
    const { container } = render(<EscalationChip escalated={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the flag is omitted entirely', () => {
    const { container } = render(<EscalationChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks an escalated incident', () => {
    render(<EscalationChip escalated />);
    expect(screen.getByText('Escalated')).toBeInTheDocument();
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MapLegend from './MapLegend';
import { WARNING_COLORS } from '@/lib/alerts';

describe('<MapLegend />', () => {
  it('renders collapsed by default (body hidden)', () => {
    render(<MapLegend />);
    const toggle = screen.getByRole('button', { name: /legend/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // None of the event rows should be rendered while collapsed.
    expect(screen.queryByText('Tornado Warning')).not.toBeInTheDocument();
  });

  it('expands on click and lists every event in the palette', () => {
    render(<MapLegend />);
    fireEvent.click(screen.getByRole('button', { name: /legend/i }));

    for (const event of Object.keys(WARNING_COLORS)) {
      expect(screen.getByText(event)).toBeInTheDocument();
    }
  });

  it('collapses again on a second click', () => {
    render(<MapLegend />);
    const toggle = screen.getByRole('button', { name: /legend/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Tornado Warning')).not.toBeInTheDocument();
  });

  it('shows the tier key and storm-motion explainer when expanded', () => {
    render(<MapLegend />);
    fireEvent.click(screen.getByRole('button', { name: /legend/i }));
    expect(screen.getByText(/warning — take action/i)).toBeInTheDocument();
    expect(screen.getByText(/watch — be aware/i)).toBeInTheDocument();
    expect(screen.getByText(/advisory — monitor/i)).toBeInTheDocument();
    expect(screen.getByText(/projected path/i)).toBeInTheDocument();
  });
});

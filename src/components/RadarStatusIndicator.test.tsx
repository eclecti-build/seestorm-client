import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RadarStatusIndicator from './RadarStatusIndicator';

describe('RadarStatusIndicator', () => {
  it('renders nothing when radar is healthy', () => {
    const { container } = render(<RadarStatusIndicator state={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('radar-status')).toBeNull();
  });

  it('announces loading politely with hidden text only', () => {
    render(<RadarStatusIndicator state="loading" />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('data-testid', 'radar-status');
    expect(el).toHaveAttribute('data-state', 'loading');
    expect(el).toHaveAttribute('aria-live', 'polite');
    expect(el).toHaveTextContent('Radar loading');
    expect(screen.getByText('Radar loading')).toHaveClass('sr-only');
  });

  it('announces the error case with its own text and data-state', () => {
    render(<RadarStatusIndicator state="error" />);
    const el = screen.getByTestId('radar-status');
    expect(el).toHaveAttribute('data-state', 'error');
    expect(screen.getByText('Radar delayed, retrying')).toHaveClass('sr-only');
  });

  it('renders exactly three decorative dots and never takes pointer events', () => {
    render(<RadarStatusIndicator state="loading" />);
    const el = screen.getByTestId('radar-status');
    const dots = el.querySelectorAll('.ss-radar-dot');
    expect(dots).toHaveLength(3);
    dots.forEach((d) => expect(d).toHaveAttribute('aria-hidden', 'true'));
    expect(el).toHaveClass('pointer-events-none');
  });
});

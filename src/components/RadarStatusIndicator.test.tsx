import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RadarStatusIndicator from './RadarStatusIndicator';

describe('RadarStatusIndicator', () => {
  it('shows nothing when radar is healthy but keeps an empty live region mounted', () => {
    render(<RadarStatusIndicator state={null} live />);
    expect(screen.queryByTestId('radar-status')).toBeNull();
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveClass('sr-only');
    expect(live).toBeEmptyDOMElement();
  });

  it('announces by changing the text of the same live region node', () => {
    const { rerender } = render(<RadarStatusIndicator state={null} live />);
    const live = screen.getByRole('status');
    rerender(<RadarStatusIndicator state="loading" live />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent('Radar loading');
    rerender(<RadarStatusIndicator state="error" live />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toHaveTextContent('Radar delayed, retrying');
    rerender(<RadarStatusIndicator state={null} live />);
    expect(screen.getByRole('status')).toBe(live);
    expect(live).toBeEmptyDOMElement();
    expect(screen.queryByTestId('radar-status')).toBeNull();
  });

  it('shows a visible loading label that is hidden from AT so it is not read twice', () => {
    render(<RadarStatusIndicator state="loading" live />);
    const el = screen.getByTestId('radar-status');
    expect(el).toHaveAttribute('data-state', 'loading');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveTextContent('Radar loading');
    expect(el).not.toHaveClass('sr-only');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('labels the error case with its own visible text and data-state', () => {
    render(<RadarStatusIndicator state="error" live />);
    const el = screen.getByTestId('radar-status');
    expect(el).toHaveAttribute('data-state', 'error');
    expect(el).toHaveTextContent('Radar delayed, retrying');
  });

  it('does not claim a retry for a failed historical or forecast frame', () => {
    // Nothing retries a non-live frame: only live mode's 30s poll does.
    render(<RadarStatusIndicator state="error" live={false} />);
    const el = screen.getByTestId('radar-status');
    expect(el).toHaveAttribute('data-state', 'error');
    expect(el).toHaveTextContent('Radar unavailable for this frame');
    expect(el).not.toHaveTextContent('retrying');
    expect(screen.getByRole('status')).toHaveTextContent('Radar unavailable for this frame');
  });

  it('keeps the loading label outside live mode', () => {
    render(<RadarStatusIndicator state="loading" live={false} />);
    expect(screen.getByTestId('radar-status')).toHaveTextContent('Radar loading');
  });

  it('renders exactly three decorative dots and never takes pointer events', () => {
    render(<RadarStatusIndicator state="loading" live />);
    const el = screen.getByTestId('radar-status');
    expect(el.querySelectorAll('.ss-radar-dot')).toHaveLength(3);
    expect(el).toHaveClass('pointer-events-none');
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the dots first and unshrinkable, in the same ink token as the label', () => {
    render(<RadarStatusIndicator state="error" live={false} />);
    const children = Array.from(screen.getByTestId('radar-status').children);
    // The CSS :nth-child pulse stagger depends on the dots being children 1-3.
    children.slice(0, 3).forEach((dot) => expect(dot).toHaveClass('ss-radar-dot', 'shrink-0'));
    expect(children[3]).toHaveTextContent('Radar unavailable for this frame');
    expect(children[3]).toHaveClass('text-[var(--ss-ink)]');
  });

  it('wraps clear of the right control stack on phones, centred on one line from sm', () => {
    render(<RadarStatusIndicator state="error" live />);
    const el = screen.getByTestId('radar-status');
    // 5rem = slider left pad (1rem) + stack right offset (0.75rem) + buttons (2.75rem) + gap.
    expect(el).toHaveClass(
      'left-[calc(1rem+env(safe-area-inset-left))]',
      'max-w-[calc(100%-5rem-env(safe-area-inset-left)-env(safe-area-inset-right))]',
      'sm:left-1/2',
      'sm:-translate-x-1/2',
      'sm:max-w-none',
    );
    expect(el).not.toHaveClass('-translate-x-1/2');
    expect(el.lastElementChild).toHaveClass('sm:whitespace-nowrap');
    expect(el.lastElementChild).not.toHaveClass('whitespace-nowrap');
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Error from './error';

const RELOAD_GUARD_KEY = 'seestorm:chunk-reload-at';

afterEach(() => {
  window.sessionStorage.removeItem(RELOAD_GUARD_KEY);
});

describe('<Error /> (route-segment boundary)', () => {
  it('renders honest crash messaging and a weather.gov link', () => {
    render(<Error error={new globalThis.Error('boom')} reset={() => {}} />);
    expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /weather\.gov/i })).toHaveAttribute(
      'href',
      'https://www.weather.gov',
    );
  });

  it('calls reset() when "Try again" is clicked', () => {
    const reset = vi.fn();
    render(<Error error={new globalThis.Error('boom')} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('shows the error digest when present', () => {
    const err = Object.assign(new globalThis.Error('boom'), { digest: 'abc123' });
    render(<Error error={err} reset={() => {}} />);
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });
});

describe('<Error /> — chunk-load-skew branch (Tier 3 Task 4 extension)', () => {
  it('renders the "app updated" reload prompt for a chunk-load-shaped error message', () => {
    render(
      <Error
        error={new globalThis.Error('ChunkLoadError: Loading chunk 4 failed')}
        reset={() => {}}
      />,
    );
    expect(screen.getByText(/app updated/i)).toBeInTheDocument();
    expect(screen.getByTestId('route-error-chunk-reload')).toBeInTheDocument();
    // The generic branch's "Try again" button must NOT appear here — reset()
    // can't fix a missing chunk (see the Step 3 rationale below).
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('renders a weather.gov escape hatch for chunk-load-shaped errors', () => {
    render(<Error error={new globalThis.Error('ChunkLoadError')} reset={() => {}} />);
    expect(screen.getByRole('link', { name: /weather\.gov/i })).toHaveAttribute(
      'href',
      'https://www.weather.gov',
    );
  });

  it('renders the "app updated" reload prompt for the observed Turbopack chunk error shape', () => {
    const e = new globalThis.Error(
      'Failed to load chunk /_next/static/chunks/11f4ipe7bso2v.js from module 77139',
    );
    e.name = 'ChunkLoadError';

    render(<Error error={e} reset={() => {}} />);

    expect(screen.getByText(/app updated/i)).toBeInTheDocument();
    expect(screen.getByTestId('route-error-chunk-reload')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('clicking Reload writes the reload-loop guard before reloading', () => {
    const reloadSpy = vi.fn(() => {
      expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).not.toBeNull();
    });
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
      configurable: true,
    });

    render(<Error error={new globalThis.Error('ChunkLoadError')} reset={() => {}} />);
    fireEvent.click(screen.getByTestId('route-error-chunk-reload'));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Reload calls window.location.reload directly (not reset())', () => {
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
      configurable: true,
    });
    const reset = vi.fn();
    render(<Error error={new globalThis.Error('ChunkLoadError')} reset={reset} />);
    fireEvent.click(screen.getByTestId('route-error-chunk-reload'));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('renders still-having-trouble copy, weather.gov, and Reload when a reload happened recently', () => {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));

    render(<Error error={new globalThis.Error('ChunkLoadError')} reset={() => {}} />);

    expect(screen.getByText(/still having trouble loading/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /weather\.gov/i })).toHaveAttribute(
      'href',
      'https://www.weather.gov',
    );
    expect(screen.getByTestId('route-error-chunk-reload')).toBeInTheDocument();
  });

  it('renders normal app-updated copy when the reload-loop guard is stale', () => {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now() - 16_000));

    render(<Error error={new globalThis.Error('ChunkLoadError')} reset={() => {}} />);

    expect(screen.getByText(/app updated/i)).toBeInTheDocument();
    expect(screen.getByText(/reload to get the latest version/i)).toBeInTheDocument();
  });

  it('an unrelated crash still gets the original generic-crash contract from Tier 1, unchanged', () => {
    render(
      <Error error={new globalThis.Error('TypeError: x is not a function')} reset={() => {}} />,
    );
    expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /weather\.gov/i })).toBeInTheDocument();
    expect(screen.queryByTestId('route-error-chunk-reload')).not.toBeInTheDocument();
  });
});

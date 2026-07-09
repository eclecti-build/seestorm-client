import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import ChunkErrorBanner from './ChunkErrorBanner';

describe('ChunkErrorBanner', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
      configurable: true,
    });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing before any chunk-load failure', () => {
    render(<ChunkErrorBanner />);
    expect(screen.queryByTestId('chunk-error-banner')).not.toBeInTheDocument();
  });

  it('shows the reload banner on a window "error" event matching a chunk-load failure', () => {
    render(<ChunkErrorBanner />);
    act(() => {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'ChunkLoadError: Loading chunk 4 failed' }),
      );
    });
    expect(screen.getByTestId('chunk-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('chunk-error-reload')).toBeInTheDocument();
  });

  it('shows the reload banner on an unhandledrejection matching the native failed-dynamic-import text', () => {
    render(<ChunkErrorBanner />);
    const event = new Event('unhandledrejection') as PromiseRejectionEvent & { reason?: unknown };
    Object.defineProperty(event, 'reason', {
      value: new Error('Failed to fetch dynamically imported module: /x.js'),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(screen.getByTestId('chunk-error-banner')).toBeInTheDocument();
  });

  it('shows the reload banner on an unhandledrejection matching the observed Turbopack chunk error shape', () => {
    render(<ChunkErrorBanner />);
    const error = new Error(
      'Failed to load chunk /_next/static/chunks/11f4ipe7bso2v.js from module 77139',
    );
    error.name = 'ChunkLoadError';
    const event = new Event('unhandledrejection') as PromiseRejectionEvent & { reason?: unknown };
    Object.defineProperty(event, 'reason', { value: error });

    act(() => {
      window.dispatchEvent(event);
    });

    expect(screen.getByTestId('chunk-error-banner')).toBeInTheDocument();
    expect(screen.getByTestId('chunk-error-reload')).toBeInTheDocument();
  });

  it('ignores unrelated errors', () => {
    render(<ChunkErrorBanner />);
    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'TypeError: x is not a function' }));
    });
    expect(screen.queryByTestId('chunk-error-banner')).not.toBeInTheDocument();
  });

  it('clicking Reload marks the session-storage guard and reloads the page', () => {
    render(<ChunkErrorBanner />);
    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'ChunkLoadError' }));
    });
    fireEvent.click(screen.getByTestId('chunk-error-reload'));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('seestorm:chunk-reload-at')).not.toBeNull();
  });

  it('shows the loop-detected message instead of a reload button if a reload happened recently', () => {
    window.sessionStorage.setItem('seestorm:chunk-reload-at', String(Date.now()));
    render(<ChunkErrorBanner />);
    act(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'ChunkLoadError' }));
    });
    expect(screen.getByTestId('chunk-error-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('chunk-error-reload')).not.toBeInTheDocument();
    expect(screen.getByText(/still having trouble/i)).toBeInTheDocument();
  });
});

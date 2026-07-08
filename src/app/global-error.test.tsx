import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GlobalError, { GlobalErrorContent } from './global-error';

describe('<GlobalErrorContent /> (root-layout boundary content)', () => {
  it('renders honest crash messaging', () => {
    render(<GlobalErrorContent error={new Error('boom')} reset={() => {}} />);
    expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
  });

  it('calls reset() when "Reload" is clicked', () => {
    const reset = vi.fn();
    render(<GlobalErrorContent error={new Error('boom')} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('<GlobalError /> (default export, full html/body shell)', () => {
  it('renders without throwing', () => {
    // Rendering a component whose root is <html>/<body> inside RTL's own
    // container triggers a harmless "cannot appear as a child of <div>"
    // DOM-nesting console warning — expected in this test environment
    // only, not a real bug. Suppress just this one assertion's noise.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<GlobalError error={new Error('boom')} reset={() => {}} />)).not.toThrow();
    consoleError.mockRestore();
  });
});

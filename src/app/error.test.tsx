import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Error from './error';

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

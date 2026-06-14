import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MapControlStack from './MapControlStack';

describe('MapControlStack', () => {
  it('renders the About link and the Settings button together', () => {
    render(<MapControlStack />);
    expect(screen.getByRole('link', { name: 'About SeeStorm' })).toHaveAttribute('href', '/about');
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('does not surface a built-by eclecti-build credit link in the map chrome', () => {
    render(<MapControlStack />);
    expect(screen.queryByRole('link', { name: /eclecti-build/i })).not.toBeInTheDocument();
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AboutButton from './AboutButton';

describe('AboutButton', () => {
  it('links to the about page with an accessible label', () => {
    render(<AboutButton />);
    const link = screen.getByRole('link', { name: 'About SeeStorm' });
    expect(link).toHaveAttribute('href', '/about');
  });
});

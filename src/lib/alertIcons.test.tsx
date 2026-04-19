import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  iconForEvent,
  TornadoIcon,
  ThunderstormIcon,
  FloodIcon,
  FreezeIcon,
  InfoIcon,
  GenericAlertIcon,
} from './alertIcons';

describe('iconForEvent()', () => {
  // Table-driven so adding a new NWS product is a one-row change. The left
  // column is the NWS event string; the right is the component we expect to
  // render. Referential identity check is enough — we're validating routing,
  // not SVG shape. The icon SVG itself is reviewed visually in the PR.
  const cases: ReadonlyArray<[string, unknown]> = [
    ['Tornado Warning', TornadoIcon],
    ['Tornado Watch', TornadoIcon],
    ['Tornado Emergency', TornadoIcon], // cousin variant — substring match
    ['Severe Thunderstorm Warning', ThunderstormIcon],
    ['Severe Thunderstorm Watch', ThunderstormIcon],
    ['Flash Flood Warning', FloodIcon],
    ['Flash Flood Watch', FloodIcon],
    ['Flood Advisory', FloodIcon], // plain Flood routes same as Flash Flood
    ['Freeze Warning', FreezeIcon],
    ['Freeze Watch', FreezeIcon],
    ['Hard Freeze Warning', FreezeIcon], // "Hard Freeze" substring still matches
    ['Hard Freeze Watch', FreezeIcon],
    ['Frost Advisory', FreezeIcon], // Frost cousin routes to same glyph
    ['Special Weather Statement', InfoIcon],
    ['Air Quality Alert', GenericAlertIcon], // nothing matches → fallback
    ['', GenericAlertIcon], // empty string → fallback, not crash
  ];

  for (const [event, expected] of cases) {
    it(`routes "${event}" to the expected icon`, () => {
      expect(iconForEvent(event)).toBe(expected);
    });
  }
});

describe('icon components', () => {
  it.each([
    ['TornadoIcon', TornadoIcon],
    ['ThunderstormIcon', ThunderstormIcon],
    ['FloodIcon', FloodIcon],
    ['FreezeIcon', FreezeIcon],
    ['InfoIcon', InfoIcon],
    ['GenericAlertIcon', GenericAlertIcon],
  ])('%s renders an <svg> with aria-hidden and currentColor stroke', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // aria-hidden so the icon doesn't duplicate the adjacent label for
    // screen readers. `currentColor` stroke so the icon inherits whatever
    // text color the enclosing row uses — theming for free.
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
  });

  it('accepts caller className / style / data-testid overrides', () => {
    const { container } = render(
      <TornadoIcon data-testid="custom" className="text-red-500" style={{ color: 'red' }} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('data-testid', 'custom');
    expect(svg).toHaveClass('text-red-500');
    expect(svg).toHaveStyle({ color: 'rgb(255, 0, 0)' });
  });
});

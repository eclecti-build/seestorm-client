import { describe, it, expect } from 'vitest';
import { scrubberMax, clampToScrubberRange } from './scrubber';
import { HRRR_FRAME_COUNT } from './radar';

describe('scrubberMax', () => {
  it('ends at the live edge when the forecast is hidden', () => {
    expect(scrubberMax(10, false)).toBe(10);
    expect(scrubberMax(0, false)).toBe(0);
  });

  it('extends by the HRRR frame count when the forecast is shown', () => {
    expect(scrubberMax(10, true)).toBe(10 + HRRR_FRAME_COUNT);
    expect(scrubberMax(0, true)).toBe(HRRR_FRAME_COUNT);
  });
});

describe('clampToScrubberRange', () => {
  it('snaps a forecast position back to the live edge when the forecast is hidden', () => {
    expect(clampToScrubberRange(10 + HRRR_FRAME_COUNT, 10, false)).toBe(10);
    expect(clampToScrubberRange(13, 10, false)).toBe(10);
  });

  it('leaves a forecast position untouched when the forecast is shown', () => {
    expect(clampToScrubberRange(13, 10, true)).toBe(13);
  });

  it('leaves historical and live positions untouched', () => {
    expect(clampToScrubberRange(5, 10, false)).toBe(5);
    expect(clampToScrubberRange(10, 10, false)).toBe(10);
  });

  it('never returns a negative index', () => {
    expect(clampToScrubberRange(-3, 10, false)).toBe(0);
  });
});

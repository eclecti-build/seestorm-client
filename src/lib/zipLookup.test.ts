import { describe, it, expect } from 'vitest';
import { normalizeZip } from './zipLookup';

describe('normalizeZip', () => {
  it('accepts a 5-digit ZIP', () => {
    expect(normalizeZip('53703')).toBe('53703');
  });

  it('strips ZIP+4 suffix', () => {
    expect(normalizeZip('53703-1234')).toBe('53703');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeZip('  53703  ')).toBe('53703');
  });

  it('rejects non-numeric input', () => {
    expect(normalizeZip('hello')).toBeNull();
  });

  it('rejects too-short / too-long inputs', () => {
    expect(normalizeZip('123')).toBeNull();
    expect(normalizeZip('123456')).toBeNull();
  });

  it('rejects malformed ZIP+4', () => {
    expect(normalizeZip('53703-')).toBeNull();
    expect(normalizeZip('53703-12')).toBeNull();
  });
});

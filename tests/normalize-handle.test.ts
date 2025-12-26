import { describe, expect, it } from 'vitest';
import { normalizeHandle } from '../src/lib/normalize-handle.js';

describe('normalizeHandle', () => {
  it('accepts bare handle', () => {
    expect(normalizeHandle('steipete')).toBe('steipete');
  });

  it('accepts @handle and trims whitespace', () => {
    expect(normalizeHandle('  @steipete  ')).toBe('steipete');
  });

  it('rejects empty input', () => {
    expect(normalizeHandle('')).toBeNull();
    expect(normalizeHandle('   ')).toBeNull();
    expect(normalizeHandle(null)).toBeNull();
  });

  it('rejects invalid characters and too-long handles', () => {
    expect(normalizeHandle('@stei-pete')).toBeNull();
    expect(normalizeHandle('@steipete!')).toBeNull();
    expect(normalizeHandle('a'.repeat(16))).toBeNull();
  });
});

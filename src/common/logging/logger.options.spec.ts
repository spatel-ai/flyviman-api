import { describe, expect, it } from 'vitest';
import { redactPath } from './logger.options.js';

describe('request log paths', () => {
  it('hide signed storage tickets', () => {
    expect(redactPath('/api/v1/dev/storage/eyJvcCI6ImdldCJ9.c2ln')).toBe(
      '/api/v1/dev/storage/[ticket]',
    );
    expect(redactPath('/api/v1/aircraft/123')).toBe('/api/v1/aircraft/123');
  });
});

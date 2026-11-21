import { describe, expect, it } from 'vitest';
import { sentFields } from './customers.service.js';

describe('sentFields', () => {
  it('names the fields sent, sorted, never their values', () => {
    const fields = sentFields({
      lastName: 'Rao',
      documentNumber: 'P1234567',
      specialAssistance: null,
      firstName: undefined,
    });
    expect(fields).toEqual(['documentNumber', 'lastName', 'specialAssistance']);
    expect(JSON.stringify(fields)).not.toContain('P1234567');
  });

  it('nothing sent, nothing named', () => {
    expect(sentFields({})).toEqual([]);
  });
});

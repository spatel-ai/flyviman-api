import { ConfigService } from '@nestjs/config';
import { FieldCipher } from './field-cipher.js';

function cipher(fill: number) {
  const key = Buffer.alloc(32, fill).toString('base64');
  return new FieldCipher({ getOrThrow: () => key } as unknown as ConfigService);
}

describe('FieldCipher', () => {
  it('round-trips a value', () => {
    const c = cipher(1);
    expect(c.decrypt(c.encrypt('P1234567'))).toBe('P1234567');
  });

  it('never stores the value in the clear and never repeats itself', () => {
    const c = cipher(1);
    const first = c.encrypt('P1234567');
    expect(first).not.toContain('P1234567');
    expect(c.encrypt('P1234567')).not.toBe(first);
  });

  it('refuses a value that was tampered with or made with another key', () => {
    const stored = cipher(1).encrypt('P1234567');
    const tampered = `${stored.slice(0, -2)}${stored.endsWith('A') ? 'B' : 'A'}A`;
    expect(() => cipher(1).decrypt(tampered)).toThrow();
    expect(() => cipher(2).decrypt(stored)).toThrow();
    expect(() => cipher(1).decrypt('plain text')).toThrow();
  });
});

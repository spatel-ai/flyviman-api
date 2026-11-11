import { hashPassword, passwordIssue, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the right password and refuses the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse batter')).toBe(false);
  });

  it('treats a malformed stored hash as a failed check', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('passwordIssue', () => {
  it('accepts a long, uncommon password', () => {
    expect(passwordIssue('correct horse battery')).toBeNull();
  });

  it.each(['short', 'Password1234', 'aaaaaaaaaaaaaa'])(
    'refuses %s',
    (password) => {
      expect(passwordIssue(password)).toEqual(expect.any(String));
    },
  );
});

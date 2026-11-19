import type { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.js';

function context(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard exemptions', () => {
  const original = RateLimitGuard.exempt;
  afterEach(() => {
    RateLimitGuard.exempt = original;
  });

  // `shouldSkip` is protected; called on the prototype with a bare receiver.
  const shouldSkip = (request: object) =>
    (
      RateLimitGuard.prototype as unknown as {
        shouldSkip(context: ExecutionContext): Promise<boolean>;
      }
    ).shouldSkip.call({}, context(request));

  it('does not count a request the auth module exempts (a racing refresh)', async () => {
    const request = { path: '/api/v1/auth/refresh' };
    RateLimitGuard.exempt = vi.fn().mockResolvedValue(true);
    await expect(shouldSkip(request)).resolves.toBe(true);
    expect(RateLimitGuard.exempt).toHaveBeenCalledWith(request);
  });

  it('counts every other request', async () => {
    RateLimitGuard.exempt = vi.fn().mockResolvedValue(false);
    await expect(shouldSkip({ path: '/api/v1/me' })).resolves.toBe(false);
  });
});

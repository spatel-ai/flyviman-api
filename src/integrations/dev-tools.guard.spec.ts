import { ConfigService } from '@nestjs/config';
import { DevToolsGuard } from './dev-tools.guard.js';

function guard(value: unknown) {
  return new DevToolsGuard({ get: () => value } as unknown as ConfigService);
}

describe('DevToolsGuard', () => {
  it('lets the route through only when the flag is exactly true', () => {
    expect(guard(true).canActivate()).toBe(true);
  });

  it.each([false, undefined, 'true', 1])('hides the route for %j', (value) => {
    expect(() => guard(value).canActivate()).toThrow('Not Found');
  });
});

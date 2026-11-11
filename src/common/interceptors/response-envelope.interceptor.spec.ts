import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { Paginated } from '../dto/paginated.js';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor.js';

function run(result: unknown) {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-1' }) }),
  } as unknown as ExecutionContext;
  const handler: CallHandler = { handle: () => of(result) };

  return firstValueFrom(
    new ResponseEnvelopeInterceptor().intercept(context, handler),
  );
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps a result in data with the request ID in meta', async () => {
    await expect(run({ status: 'ok' })).resolves.toEqual({
      data: { status: 'ok' },
      meta: { requestId: 'req-1' },
    });
  });

  it('moves pagination fields into meta', async () => {
    await expect(run(new Paginated(['a', 'b'], 2, 20, 42))).resolves.toEqual({
      data: ['a', 'b'],
      meta: { requestId: 'req-1', page: 2, pageSize: 20, total: 42 },
    });
  });

  it('returns null data for an empty result', async () => {
    await expect(run(undefined)).resolves.toEqual({
      data: null,
      meta: { requestId: 'req-1' },
    });
  });
});

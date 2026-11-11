import {
  ArgumentsHost,
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import {
  AllExceptionsFilter,
  describeError,
  ErrorBody,
} from './all-exceptions.filter.js';

function run(exception: unknown) {
  const json = vi.fn<(body: ErrorBody) => void>();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-1', method: 'GET', path: '/x' }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;

  const filter = new AllExceptionsFilter();
  // Silence the expected error log for 5xx cases.
  vi.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  filter.catch(exception, host);

  return {
    status: status.mock.calls[0][0] as number,
    body: json.mock.calls[0][0],
  };
}

describe('AllExceptionsFilter', () => {
  it('keeps the code and details of an AppException', () => {
    const { status, body } = run(
      new AppException(
        'BOOKING_PRICE_CHANGED',
        'The price has changed.',
        HttpStatus.CONFLICT,
        [{ field: 'totalMinor', issue: 'changed' }],
      ),
    );

    expect(status).toBe(409);
    expect(body.error).toEqual({
      code: 'BOOKING_PRICE_CHANGED',
      message: 'The price has changed.',
      details: [{ field: 'totalMinor', issue: 'changed' }],
      requestId: 'req-1',
    });
  });

  it('maps framework exceptions to catalogue codes', () => {
    expect(run(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
  });

  it('passes validation details through', () => {
    const { status, body } = run(
      new BadRequestException({
        message: 'The request is not valid.',
        details: [{ field: 'email', issue: 'email must be an email' }],
      }),
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([
      { field: 'email', issue: 'email must be an email' },
    ]);
  });

  it('hides the message of unexpected errors', () => {
    const { status, body } = run(new Error('connection string leaked'));

    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain('leaked');
  });
});

describe('describeError', () => {
  it('names the error and where it was thrown, without its message', () => {
    class PrismaClientValidationError extends Error {}
    const error = new PrismaClientValidationError(
      'Invalid `prisma.passenger.update()` invocation: firstName: "Kavya", documentNumber: "P1234567"',
    );
    const described = describeError(error);
    expect(described).toContain('PrismaClientValidationError');
    expect(described).not.toContain('Kavya');
    expect(described).not.toContain('P1234567');
  });

  it('includes an error code when there is one', () => {
    const error = Object.assign(new Error('secret detail'), { code: 'P2002' });
    expect(describeError(error)).toContain('code=P2002');
    expect(describeError('a string')).toBe('non-error thrown');
  });
});

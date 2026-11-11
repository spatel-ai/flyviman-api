import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../context/request-context.js';

const HEADER = 'x-request-id';
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Gives every request an ID, reusing a well-formed incoming `X-Request-Id`.
 * The ID is echoed in the response header and in every response envelope,
 * and the rest of the request runs inside a request context that carries it.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.header(HEADER);
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  request.id = id;
  response.setHeader(HEADER, id);
  requestContext.run({ requestId: id, ipAddress: request.ip ?? null }, next);
}

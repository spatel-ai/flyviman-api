import { randomInt } from 'node:crypto';
import { WEB_PROXY_SECRET } from '../../playwright.config.js';
import {
  CLIENT_ADDRESS_HEADER,
  signClientAddress,
} from '../../src/common/middleware/client-address.middleware.js';

/** A made-up visitor address, different on every call and every run. */
export function visitorAddress(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

/** Headers the web host adds when it proxies a request from `address`. */
export function asVisitor(address: string): Record<string, string> {
  return {
    [CLIENT_ADDRESS_HEADER]: signClientAddress(address, WEB_PROXY_SECRET),
  };
}

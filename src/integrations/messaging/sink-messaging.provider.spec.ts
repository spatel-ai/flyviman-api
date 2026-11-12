import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SinkMessagingProvider } from './sink-messaging.provider.js';

describe('SinkMessagingProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a message without logging who it was for or what it said', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const sent = await new SinkMessagingProvider().send({
      channel: 'EMAIL',
      to: 'person@example.com',
      subject: 'Your code',
      body: 'Your code is 123456',
    });
    expect(sent.providerMessageId).toMatch(/^sink-/);
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('EMAIL');
    expect(logged).not.toContain('person@example.com');
    expect(logged).not.toContain('123456');
    expect(logged).not.toContain('Your code');
  });
});

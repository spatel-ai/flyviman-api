import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboundMessage } from './messaging.provider.js';
import { MockMessagingProvider } from './mock-messaging.provider.js';
import { SinkMessagingProvider } from './sink-messaging.provider.js';
import {
  isReservedAddress,
  type MailTransport,
  SmtpDeliveryError,
  SmtpMessagingProvider,
  type SmtpSettings,
} from './smtp-messaging.provider.js';

const email: OutboundMessage = {
  channel: 'EMAIL',
  to: 'asha.rao@gmail.com',
  subject: 'Your sign-in code',
  body: 'Your code is 482913',
  html: 'Your code is 482913',
};

function setup(settings: Partial<SmtpSettings> = {}) {
  const sendMail = vi.fn<MailTransport['sendMail']>(() =>
    Promise.resolve({ messageId: '<abc@gmail.com>' }),
  );
  const mock = new MockMessagingProvider({
    get: () => 'test',
  } as unknown as ConfigService);
  const sink = new SinkMessagingProvider();
  const provider = new SmtpMessagingProvider(
    { sendMail },
    {
      from: { name: 'Flyviman', address: 'owner@gmail.com' },
      devOutbox: false,
      ...settings,
    },
    mock,
    sink,
  );
  return { provider, sendMail, mock, sink };
}

/** Everything any logger was asked to print. */
function captureLogs() {
  return (['log', 'debug', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation(() => {}),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('SmtpMessagingProvider', () => {
  it('sends an email from the configured name and address, with text and HTML', async () => {
    captureLogs();
    const { provider, sendMail } = setup();
    const sent = await provider.send(email);

    expect(sent.providerMessageId).toBe('<abc@gmail.com>');
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Flyviman', address: 'owner@gmail.com' },
      to: 'asha.rao@gmail.com',
      subject: 'Your sign-in code',
      text: 'Your code is 482913',
      html: 'Your code is 482913',
      headers: undefined,
    });
  });

  it('delivers every email to EMAIL_REDIRECT_TO, naming the real recipient', async () => {
    captureLogs();
    const { provider, sendMail } = setup({ redirectTo: 'owner@gmail.com' });
    await provider.send({ ...email, to: 'customer@flyviman.test' });

    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe('owner@gmail.com');
    expect(mail.subject).toBe('[to customer@flyviman.test] Your sign-in code');
    expect(mail.headers).toEqual({
      'X-Flyviman-Original-To': 'customer@flyviman.test',
    });
  });

  it.each([
    'customer@flyviman.test',
    'someone@example.com',
    'someone@mail.example.org',
    'a@b.invalid',
    'a@b.example',
  ])(
    'skips %s without sending or failing, and logs only a count',
    async (to) => {
      const logs = captureLogs();
      const { provider, sendMail } = setup();
      const sent = await provider.send({ ...email, to });

      expect(sendMail).not.toHaveBeenCalled();
      expect(sent.providerMessageId).toMatch(/^smtp-skipped-/);
      const logged = logs.flatMap((spy) => spy.mock.calls.flat()).join(' ');
      expect(logged).toContain('1 so far');
      expect(logged).not.toContain(to);
    },
  );

  it('maps an SMTP failure to an error carrying only its code', async () => {
    captureLogs();
    const { provider, sendMail } = setup();
    sendMail.mockRejectedValueOnce(
      Object.assign(new Error('550 asha.rao@gmail.com: mailbox unavailable'), {
        code: 'EENVELOPE',
        response: '550 asha.rao@gmail.com',
      }),
    );

    const failure = await provider.send(email).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SmtpDeliveryError);
    const { name, code, message } = failure as SmtpDeliveryError;
    expect(name).toBe('SmtpDeliveryError');
    expect(code).toBe('EENVELOPE');
    expect(message).not.toContain('asha');

    sendMail.mockRejectedValueOnce(new Error('asha.rao@gmail.com'));
    await expect(provider.send(email)).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
  });

  it('never logs the recipient, subject or body', async () => {
    const logs = captureLogs();
    const { provider } = setup({ devOutbox: true });
    await provider.send(email);
    await provider.send({ ...email, channel: 'SMS', to: '+919876543210' });

    const logged = logs.flatMap((spy) => spy.mock.calls.flat()).join(' ');
    for (const secret of ['asha', '482913', 'sign-in code', '+919876543210']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('keeps each email in the development outbox under its real recipient when dev tools are on', async () => {
    captureLogs();
    const { provider, mock } = setup({
      devOutbox: true,
      redirectTo: 'owner@gmail.com',
    });
    await provider.send({ ...email, to: 'customer@flyviman.test' });

    expect(mock.messagesTo('customer@flyviman.test')).toHaveLength(1);
    expect(mock.messagesTo('owner@gmail.com')).toHaveLength(0);
  });

  it('keeps nothing in the outbox when dev tools are off', async () => {
    captureLogs();
    const { provider, mock } = setup();
    await provider.send(email);
    expect(mock.messagesTo(email.to)).toHaveLength(0);
  });

  it('sends SMS and WhatsApp to the outbox with dev tools, else discards them like the sink', async () => {
    captureLogs();
    const sms = { channel: 'SMS' as const, to: '+919876543210', body: 'x' };

    const withTools = setup({ devOutbox: true });
    await withTools.provider.send(sms);
    expect(withTools.sendMail).not.toHaveBeenCalled();
    expect(withTools.mock.messagesTo(sms.to)).toHaveLength(1);

    const without = setup();
    const discard = vi.spyOn(without.sink, 'send');
    const sent = await without.provider.send({ ...sms, channel: 'WHATSAPP' });
    expect(without.sendMail).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(sent.providerMessageId).toMatch(/^sink-/);
    expect(without.mock.messagesTo(sms.to)).toHaveLength(0);
  });
});

describe('isReservedAddress', () => {
  it.each([
    ['a@flyviman.test', true],
    ['a@FLYVIMAN.TEST', true],
    ['a@example.com', true],
    ['a@example.com.', true],
    ['a@notexample.com', false],
    ['a@gmail.com', false],
    ['a@flyviman.com', false],
  ])('%s → %s', (address, reserved) => {
    expect(isReservedAddress(address)).toBe(reserved);
  });
});

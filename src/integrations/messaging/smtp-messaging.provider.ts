import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import {
  MessagingProvider,
  OutboundMessage,
  SentMessage,
} from './messaging.provider.js';
import type { MockMessagingProvider } from './mock-messaging.provider.js';
import type { SinkMessagingProvider } from './sink-messaging.provider.js';

/** The part of a nodemailer transport this provider uses; stubbed in tests. */
export interface MailTransport {
  sendMail(mail: {
    from: { name: string; address: string };
    to: string;
    subject?: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export interface SmtpSettings {
  from: { name: string; address: string };
  /** Every email goes here instead (EMAIL_REDIRECT_TO), for development. */
  redirectTo?: string;
  /** ENABLE_DEV_TOOLS: keep each message in the development outbox too. */
  devOutbox: boolean;
}

/**
 * Thrown when the SMTP server refuses or cannot be reached. Carries only a
 * short error code: a provider's message can repeat the recipient, and the
 * notification outbox logs the error's name and retries the row.
 */
export class SmtpDeliveryError extends Error {
  override readonly name = 'SmtpDeliveryError';
  constructor(readonly code: string) {
    super(`SMTP delivery failed (${code})`);
  }
}

const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** Reserved for tests and documentation (RFC 2606, RFC 6761): mail to them bounces. */
export function isReservedAddress(address: string): boolean {
  const domain = address
    .slice(address.lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return (
    RESERVED_TLDS.has(tld) ||
    RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
  );
}

/** Gmail by default: port 465 is TLS from the start, any other port must upgrade with STARTTLS. */
export function createSmtpTransport(config: ConfigService): MailTransport {
  const port = config.get<number>('SMTP_PORT') ?? 465;
  return createTransport({
    host: config.get<string>('SMTP_HOST'),
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: {
      user: config.get<string>('USER_EMAIL'),
      pass: config.get<string>('USER_EMAIL_PASSWORD'),
    },
    // Short, so a batch of the outbox (20 rows) normally stays inside its
    // 300 s lease; a server stalling every row at every stage would not.
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
    logger: false,
    debug: false,
  });
}

/**
 * MESSAGING_PROVIDER=smtp: email goes out through an SMTP server (Gmail with
 * an app password by default). SMS and WhatsApp have no provider yet: they
 * go to the development outbox with ENABLE_DEV_TOOLS, and are otherwise
 * discarded as the sink does.
 *
 * Nothing about a message is logged but counts: no recipient, subject or
 * body. Reserved test domains (`*.flyviman.test` demo accounts) are skipped,
 * not sent, and the send counts as done. With EMAIL_REDIRECT_TO every email
 * goes to that one inbox, the original recipient shown in the subject.
 */
export class SmtpMessagingProvider extends MessagingProvider {
  private readonly logger = new Logger('SmtpMessaging');
  private sent = 0;
  private skipped = 0;

  constructor(
    private readonly transport: MailTransport,
    private readonly settings: SmtpSettings,
    private readonly mock: MockMessagingProvider,
    private readonly sink: SinkMessagingProvider,
  ) {
    super();
    this.logger.log(
      `Email is sent by SMTP${settings.redirectTo ? '; every email is redirected to one inbox (EMAIL_REDIRECT_TO)' : ''}`,
    );
  }

  async send(message: OutboundMessage): Promise<SentMessage> {
    if (message.channel !== 'EMAIL') {
      return (this.settings.devOutbox ? this.mock : this.sink).send(message);
    }
    // Under the original address, so tests read codes as with the mock.
    if (this.settings.devOutbox) this.mock.record(message);

    const redirect = this.settings.redirectTo;
    const to = redirect ?? message.to;
    if (isReservedAddress(to)) {
      this.skipped += 1;
      this.logger.debug(
        `Skipped an email to a reserved test domain (${this.skipped} so far)`,
      );
      return { providerMessageId: `smtp-skipped-${randomUUID()}` };
    }

    const original = message.to.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');
    let info: { messageId?: string };
    try {
      info = await this.transport.sendMail({
        from: this.settings.from,
        to,
        subject: redirect
          ? `[to ${original}] ${message.subject ?? ''}`.trimEnd()
          : message.subject,
        text: message.body,
        html: message.html,
        headers: redirect ? { 'X-Flyviman-Original-To': original } : undefined,
      });
    } catch (error) {
      throw new SmtpDeliveryError(errorCode(error));
    }
    this.sent += 1;
    this.logger.debug(`Sent an email by SMTP (${this.sent} so far)`);
    return { providerMessageId: info.messageId ?? `smtp-${randomUUID()}` };
  }
}

/** nodemailer's code (`EAUTH`, `ECONNECTION`, `ETIMEDOUT`, …), never its message. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)
    ? code
    : 'UNKNOWN';
}

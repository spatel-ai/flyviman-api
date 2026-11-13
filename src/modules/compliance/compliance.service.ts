import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { Paginated } from '../../common/dto/paginated.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import { NotificationChannel } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import { documentLabel } from './document-labels.js';
import {
  alertThreshold,
  dateAfter,
  type ExpiringDocument,
  expiringDocuments,
  type ExpiryKind,
  indiaToday,
} from './expiry.js';

const LOCK_KEY = 'compliance:expiry-alerts:lock';
const LAST_RUN_KEY = 'compliance:expiry-alerts:last-run';
const LOCK_SECONDS = 10 * 60;
/** The furthest ahead an alert looks (the largest threshold, D-048). */
const ALERT_WINDOW_DAYS = 30;

/** 1 Dec 2026, as alerts show a date. */
function displayDate(date: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Document expiry (M3 step 8, D-048, D-072): the daily alert job and the
 * admin list of expiring documents. Owns DocumentExpiryAlert; reads
 * documents through the operators and aircraft modules.
 */
@Injectable()
export class ComplianceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly aircraft: AircraftService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * A host that sleeps (the free Render instance) can miss the daily run;
   * on start-up the job runs if the last run is over 23 hours old. Not in
   * tests, which trigger it themselves.
   */
  onApplicationBootstrap(): void {
    if (this.config.get('NODE_ENV') === 'test') return;
    setTimeout(() => {
      void this.catchUp();
    }, 5_000).unref();
  }

  private async catchUp(): Promise<void> {
    try {
      const last = await this.redis.get(LAST_RUN_KEY);
      if (last && Date.now() - Date.parse(last) < 23 * 3_600_000) return;
      await this.runExpiryAlerts();
    } catch (error) {
      this.logger.error(
        `Expiry alert catch-up failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /** Every day at 09:00 in India. */
  @Cron('30 3 * * *', { name: 'document-expiry-alerts', timeZone: 'UTC' })
  async daily(): Promise<void> {
    try {
      await this.runExpiryAlerts();
    } catch (error) {
      this.logger.error(
        `Expiry alerts failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Sends the alerts that are due: each document's nearest threshold
   * reached (30, 7 or 0 days), once per expiry date, in the app and by email
   * to the operator's administrators. The alert row and its notifications
   * are written in one transaction (the outbox, D-072), so an alert is
   * recorded if and only if it will be sent. One instance at a time.
   */
  async runExpiryAlerts(
    now = new Date(),
  ): Promise<{ alerted: number; skipped: boolean }> {
    const locked = await this.redis.set(
      LOCK_KEY,
      '1',
      'EX',
      LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { alerted: 0, skipped: true };
    try {
      const today = indiaToday(now);
      const due = await this.documents(today, ALERT_WINDOW_DAYS);
      let alerted = 0;
      for (const document of due) {
        const threshold = alertThreshold(document.daysLeft);
        if (threshold === null) continue;
        if (await this.alert(document, threshold)) alerted += 1;
      }
      await this.redis.set(LAST_RUN_KEY, now.toISOString());
      if (alerted > 0) this.logger.log(`Expiry alerts sent: ${alerted}`);
      return { alerted, skipped: false };
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }

  /** Expiring and expired documents for operations, soonest first. */
  async expiring(query: {
    withinDays: number;
    kind?: ExpiryKind;
    page: number;
    pageSize: number;
  }): Promise<Paginated<ExpiringDocument>> {
    const today = indiaToday(new Date());
    const all = (await this.documents(today, query.withinDays)).filter(
      (document) => !query.kind || document.kind === query.kind,
    );
    const start = (query.page - 1) * query.pageSize;
    return new Paginated(
      all.slice(start, start + query.pageSize),
      query.page,
      query.pageSize,
      all.length,
    );
  }

  private async documents(
    today: string,
    withinDays: number,
  ): Promise<ExpiringDocument[]> {
    const until = dateAfter(today, withinDays);
    const [operatorDocuments, aircraftDocuments] = await Promise.all([
      this.operators.expiryCandidates(until),
      this.aircraft.expiryCandidates(until),
    ]);
    return expiringDocuments(
      [...operatorDocuments, ...aircraftDocuments],
      today,
      withinDays,
    );
  }

  /** One alert; false if it was already sent for this threshold and date. */
  private async alert(
    document: ExpiringDocument,
    threshold: number,
  ): Promise<boolean> {
    const administrators = await this.operators.administrators(
      document.operatorId,
    );
    const templateKey =
      threshold === 0 ? 'document.expired' : 'document.expiring';
    const variables = {
      document: documentLabel(document.kind, document.type),
      subject: document.registration ?? document.operatorName,
      date: displayDate(document.expiresAt),
      days: document.daysLeft,
    };
    const queued = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.documentExpiryAlert.create({
          data: {
            kind: document.kind,
            documentId: document.documentId,
            threshold,
            expiresAt: document.expiresAt,
          },
        });
        const ids: string[] = [];
        for (const administrator of administrators) {
          ids.push(
            await this.notifications.enqueue(
              {
                userId: administrator.id,
                channel: NotificationChannel.IN_APP,
                templateKey,
                variables,
              },
              tx,
            ),
          );
          if (administrator.email) {
            ids.push(
              await this.notifications.enqueue(
                {
                  userId: administrator.id,
                  channel: NotificationChannel.EMAIL,
                  to: administrator.email,
                  templateKey,
                  variables,
                },
                tx,
              ),
            );
          }
        }
        return ids;
      }),
    );
    if (!queued) return false;
    // Sent at once; the outbox retries anything that fails.
    for (const id of queued) await this.notifications.deliver(id);
    return true;
  }
}

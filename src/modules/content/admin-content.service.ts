import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { requestContext } from '../../common/context/request-context.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { ContentItem } from '../../generated/prisma/client.js';
import {
  ContentKind,
  type NotificationChannel,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  DEFAULT_TEMPLATES,
  placeholdersOf,
} from '../notifications/templates.js';

export type ManagedKind = 'BANNER' | 'FAQ';

export interface ItemInput {
  title?: string;
  body?: string;
  region?: string | null;
  sortOrder?: number;
  published?: boolean;
}

function notFound(what: string): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

function slugFrom(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'item'}-${randomBytes(3).toString('hex')}`;
}

/** What an audit record keeps of a banner or question: public copy only. */
function snapshot(item: ContentItem) {
  return {
    slug: item.slug,
    title: item.title,
    body: item.body,
    region: item.region,
    sortOrder: item.sortOrder,
    published: item.publishedAt !== null,
  };
}

const isoDay = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class AdminContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Banners and questions -------------------------------------------------

  list(kind: ManagedKind): Promise<ContentItem[]> {
    return this.prisma.contentItem.findMany({
      where: { kind },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async create(kind: ManagedKind, input: ItemInput): Promise<ContentItem> {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.contentItem.create({
        data: {
          kind,
          slug: slugFrom(input.title ?? ''),
          title: input.title ?? '',
          body: input.body ?? '',
          region: input.region?.trim().toUpperCase() || null,
          sortOrder: input.sortOrder ?? 0,
          publishedAt: input.published ? new Date() : null,
        },
      });
      await this.audit.record(
        {
          action: `content.${kind.toLowerCase()}.create`,
          entityType: 'ContentItem',
          entityId: item.id,
          after: snapshot(item),
        },
        tx,
      );
      return item;
    });
  }

  async update(
    kind: ManagedKind,
    id: string,
    input: ItemInput,
  ): Promise<ContentItem> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.contentItem.findFirst({ where: { id, kind } });
      if (!before) throw notFound('Entry');
      let publishedAt = before.publishedAt;
      if (input.published === true && !publishedAt) publishedAt = new Date();
      if (input.published === false) publishedAt = null;
      const item = await tx.contentItem.update({
        where: { id },
        data: {
          title: input.title,
          body: input.body,
          region:
            input.region === undefined
              ? undefined
              : input.region?.trim().toUpperCase() || null,
          sortOrder: input.sortOrder,
          publishedAt,
        },
      });
      await this.audit.record(
        {
          action: `content.${kind.toLowerCase()}.update`,
          entityType: 'ContentItem',
          entityId: id,
          before: snapshot(before),
          after: snapshot(item),
        },
        tx,
      );
      return item;
    });
  }

  async remove(kind: ManagedKind, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.contentItem.findFirst({ where: { id, kind } });
      if (!before) throw notFound('Entry');
      await tx.contentItem.delete({ where: { id } });
      await this.audit.record(
        {
          action: `content.${kind.toLowerCase()}.delete`,
          entityType: 'ContentItem',
          entityId: id,
          before: snapshot(before),
        },
        tx,
      );
    });
  }

  // Policies --------------------------------------------------------------

  async listPolicies() {
    const [items, counts] = await Promise.all([
      this.prisma.contentItem.findMany({
        where: { kind: ContentKind.POLICY },
        orderBy: { slug: 'asc' },
      }),
      this.prisma.policyVersion.groupBy({ by: ['slug'], _count: true }),
    ]);
    const count = new Map(counts.map((row) => [row.slug, row._count]));
    return items.map((item) => ({
      item,
      // A policy seeded before versions were kept counts as one.
      versionCount: Math.max(count.get(item.slug) ?? 0, item.version ? 1 : 0),
    }));
  }

  /**
   * Publishes a new version. The text a customer accepted is never changed:
   * the current text is kept as a `PolicyVersion` first, and the new text
   * gets a new version string. `baseVersion` is the version count
   * the editor loaded: if another version was published since, 409
   * `CONTENT_VERSION_CONFLICT`. Sending the current text again is refused
   * (422 `CONTENT_UNCHANGED`). Both are checked under the per-policy lock, so
   * two publishes at once cannot both pass.
   */
  async publishPolicy(
    slug: string,
    input: { title: string; body: string; baseVersion: number },
  ) {
    return this.prisma.$transaction(async (tx) => {
      // One publisher per policy at a time.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`policy:${slug}`}))`;
      const key = { kind: ContentKind.POLICY, slug };
      const current = await tx.contentItem.findUnique({
        where: { kind_slug: key },
      });
      const versions = await tx.policyVersion.findMany({
        where: { slug },
        select: { version: true },
      });
      const used = new Set(versions.map((row) => row.version));
      // The count the editor saw (`listPolicies`), before anything is written.
      const latest = Math.max(versions.length, current?.version ? 1 : 0);
      if (input.baseVersion !== latest) {
        throw new AppException(
          'CONTENT_VERSION_CONFLICT',
          'Another version of this policy was published after you opened it. Reload it and make your changes again.',
          HttpStatus.CONFLICT,
          [{ field: 'baseVersion', issue: `The latest version is ${latest}.` }],
        );
      }
      if (
        current?.version &&
        current.publishedAt &&
        !used.has(current.version)
      ) {
        await tx.policyVersion.create({
          data: {
            slug,
            version: current.version,
            title: current.title,
            body: current.body,
            publishedAt: current.publishedAt,
          },
        });
        used.add(current.version);
      }
      if (
        current?.publishedAt &&
        current.title === input.title &&
        current.body === input.body
      ) {
        throw new AppException(
          'CONTENT_UNCHANGED',
          'This text is already the published version.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const text = { title: input.title, body: input.body };

      let version = isoDay();
      for (let n = 2; used.has(version); n += 1) version = `${isoDay()}.${n}`;
      const publishedAt = new Date();
      await tx.policyVersion.create({
        data: {
          slug,
          version,
          title: input.title,
          body: input.body,
          publishedAt,
          publishedBy: requestContext.get()?.actor?.id ?? null,
        },
      });
      const item = await tx.contentItem.upsert({
        where: { kind_slug: key },
        create: { ...key, ...text, version, publishedAt },
        update: { ...text, version, publishedAt },
      });
      await this.audit.record(
        {
          action: 'content.policy.publish',
          entityType: 'Policy',
          entityId: slug,
          before: current
            ? {
                version: current.version,
                title: current.title,
                bodyLength: current.body.length,
              }
            : undefined,
          after: {
            version,
            title: item.title,
            bodyLength: item.body.length,
          },
        },
        tx,
      );
      return { item, versionCount: used.size + 1 };
    });
  }

  // Notification templates ------------------------------------------------

  async listTemplates() {
    const stored = await this.prisma.notificationTemplate.findMany();
    const byKey = new Map(
      stored.map((row) => [`${row.key}|${row.channel}`, row]),
    );
    return DEFAULT_TEMPLATES.map((builtIn) => {
      const row = byKey.get(`${builtIn.key}|${builtIn.channel}`);
      return {
        key: builtIn.key,
        channel: builtIn.channel,
        subject: row ? row.subject : (builtIn.subject ?? null),
        body: row ? row.body : builtIn.body,
        isActive: row ? row.isActive : true,
        placeholders: this.required(builtIn),
        stored: Boolean(row),
      };
    });
  }

  private required(builtIn: { subject?: string; body: string }): string[] {
    return [
      ...new Set([
        ...placeholdersOf(builtIn.subject),
        ...placeholdersOf(builtIn.body),
      ]),
    ].sort();
  }

  async updateTemplate(
    key: string,
    channel: NotificationChannel,
    input: { subject?: string | null; body: string; isActive: boolean },
  ) {
    const builtIn = DEFAULT_TEMPLATES.find(
      (t) => t.key === key && t.channel === channel,
    );
    if (!builtIn) throw notFound('Template');

    const subject = input.subject?.trim() || null;
    const details: { field: string; issue: string }[] = [];
    if (builtIn.subject && !subject) {
      details.push({ field: 'subject', issue: 'A subject is required.' });
    }
    if (!builtIn.subject && subject) {
      details.push({ field: 'subject', issue: 'This channel has no subject.' });
    }
    const required = this.required(builtIn);
    const present = new Set([
      ...placeholdersOf(subject),
      ...placeholdersOf(input.body),
    ]);
    const missing = required.filter((name) => !present.has(name));
    const unknown = [...present].filter((name) => !required.includes(name));
    if (missing.length > 0) {
      details.push({
        field: 'body',
        issue: `Keep the placeholders ${missing.map((n) => `{{${n}}}`).join(', ')}.`,
      });
    }
    if (unknown.length > 0) {
      details.push({
        field: 'body',
        issue: `Unknown placeholders ${unknown.map((n) => `{{${n}}}`).join(', ')}; allowed: ${required.map((n) => `{{${n}}}`).join(', ') || 'none'}.`,
      });
    }
    if (details.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The template is not valid.',
        HttpStatus.BAD_REQUEST,
        details,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const where = { key_channel: { key, channel } };
      const before = await tx.notificationTemplate.findUnique({ where });
      const row = await tx.notificationTemplate.upsert({
        where,
        create: {
          key,
          channel,
          subject,
          body: input.body,
          isActive: input.isActive,
        },
        update: { subject, body: input.body, isActive: input.isActive },
      });
      const shape = (t: {
        subject: string | null;
        body: string;
        isActive: boolean;
      }) => ({ subject: t.subject, body: t.body, isActive: t.isActive });
      await this.audit.record(
        {
          action: 'content.notification_template.update',
          entityType: 'NotificationTemplate',
          entityId: `${key}:${channel}`,
          before: shape(
            before ?? {
              subject: builtIn.subject ?? null,
              body: builtIn.body,
              isActive: true,
            },
          ),
          after: shape(row),
        },
        tx,
      );
      return {
        key,
        channel,
        subject: row.subject,
        body: row.body,
        isActive: row.isActive,
        placeholders: required,
        stored: true,
      };
    });
  }
}

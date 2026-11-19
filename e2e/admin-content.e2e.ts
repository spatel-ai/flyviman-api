import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';
import { csrfHeaders, signIn } from './support/session.js';

test.describe('banners and questions', () => {
  test('operations create, publish, change and delete a banner, audited', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const headers = await csrfHeaders(request);
    const title = `Winter fares ${randomUUID()}`;

    const created = await request.post('admin/content/banners', {
      headers,
      data: { title, body: 'Charter from Mumbai.', region: 'in' },
    });
    expect(created.status()).toBe(201);
    const banner = (await created.json()).data;
    expect(banner).toMatchObject({ title, region: 'IN', publishedAt: null });
    expect(banner.slug).toMatch(/^winter-fares-/);

    const published = await request.patch(
      `admin/content/banners/${banner.id}`,
      {
        headers,
        data: { published: true, title: `${title} (new)` },
      },
    );
    expect(published.status()).toBe(200);
    expect((await published.json()).data.publishedAt).not.toBeNull();

    const listed = await request.get('admin/content/banners');
    expect(
      (await listed.json()).data.map((b: { id: string }) => b.id),
    ).toContain(banner.id);
    // A banner is not reachable as a question.
    const wrongKind = await request.patch(`admin/content/faqs/${banner.id}`, {
      headers,
      data: { title: 'x' },
    });
    expect(wrongKind.status()).toBe(404);

    const unpublished = await request.patch(
      `admin/content/banners/${banner.id}`,
      { headers, data: { published: false } },
    );
    expect((await unpublished.json()).data.publishedAt).toBeNull();

    const removed = await request.delete(`admin/content/banners/${banner.id}`, {
      headers,
    });
    expect(removed.status()).toBe(204);

    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityType: 'ContentItem', entityId: banner.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((row) => row.action)).toEqual([
      'content.banner.create',
      'content.banner.update',
      'content.banner.update',
      'content.banner.delete',
    ]);
    expect(audit[1].before).toMatchObject({ title, published: false });
    expect(audit[1].after).toMatchObject({
      title: `${title} (new)`,
      published: true,
    });
  });

  test('questions are validated and closed to other roles', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const headers = await csrfHeaders(request);
    const empty = await request.post('admin/content/faqs', {
      headers,
      data: { title: '', body: 'x' },
    });
    expect(empty.status()).toBe(400);
    // Hidden characters could make text read differently from what is stored.
    const hidden = await request.post('admin/content/faqs', {
      headers,
      data: { title: 'Refunds \u202Eenil', body: 'x' },
    });
    expect(hidden.status()).toBe(400);
    expect((await hidden.json()).error.code).toBe('VALIDATION_ERROR');
    const bell = await request.post('admin/content/banners', {
      headers,
      data: { title: 'Sale', body: 'Ring \u0007' },
    });
    expect(bell.status()).toBe(400);
    const missing = await request.patch(
      'admin/content/faqs/00000000-0000-4000-8000-000000000000',
      { headers, data: { title: 'x' } },
    );
    expect(missing.status()).toBe(404);

    for (const account of ['finance', 'customer', 'operatorAdmin'] as const) {
      await signIn(request, account);
      expect((await request.get('admin/content/faqs')).status()).toBe(403);
    }
  });
});

test.describe('policies', () => {
  test('publishing keeps every version and the public read shows the newest', async ({
    request,
  }) => {
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    await withPrisma((prisma) =>
      prisma.contentItem.create({
        data: {
          kind: 'POLICY',
          slug,
          title: 'Old title',
          body: 'Old text, accepted by customers.',
          version: '2026-01-01',
          publishedAt: new Date('2026-01-01'),
        },
      }),
    );

    await signIn(request, 'ops');
    const opsHeaders = await csrfHeaders(request);
    const forbidden = await request.put(`admin/content/policies/${slug}`, {
      headers: opsHeaders,
      data: { title: 'T', body: 'B' },
    });
    expect(forbidden.status()).toBe(403);
    expect((await request.get('admin/content/policies')).status()).toBe(200);

    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);
    const first = await request.put(`admin/content/policies/${slug}`, {
      headers,
      data: { title: 'New title', body: 'New text.' },
    });
    expect(first.status()).toBe(200);
    const one = (await first.json()).data;
    expect(one.version).toBe(new Date().toISOString().slice(0, 10));
    expect(one.versionCount).toBe(2);

    // The same text again is not a new version.
    const again = await request.put(`admin/content/policies/${slug}`, {
      headers,
      data: { title: 'New title', body: 'New text.' },
    });
    expect((await again.json()).data).toMatchObject({
      version: one.version,
      versionCount: 2,
    });

    const second = await request.put(`admin/content/policies/${slug}`, {
      headers,
      data: { title: 'New title', body: 'Newer text.' },
    });
    expect((await second.json()).data.version).toBe(`${one.version}.2`);

    const versions = await withPrisma((prisma) =>
      prisma.policyVersion.findMany({
        where: { slug },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(versions.map((v) => [v.version, v.body])).toEqual([
      ['2026-01-01', 'Old text, accepted by customers.'],
      [one.version, 'New text.'],
      [`${one.version}.2`, 'Newer text.'],
    ]);

    const publicRead = await request.get(`content/policies/${slug}`);
    expect((await publicRead.json()).data).toMatchObject({
      body: 'Newer text.',
      version: `${one.version}.2`,
    });

    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityType: 'Policy', entityId: slug },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit).toHaveLength(2);
    expect(audit[0].before).toMatchObject({ version: '2026-01-01' });
    expect(audit[0].after).toMatchObject({ version: one.version });

    // Paragraphs are separated by blank lines; other hidden characters are refused.
    const hidden = await request.put(`admin/content/policies/${slug}`, {
      headers,
      data: { title: 'New title', body: 'Fees \u202Eapply.' },
    });
    expect(hidden.status()).toBe(400);
    const paragraphs = await request.put(`admin/content/policies/${slug}`, {
      headers,
      data: { title: 'New title', body: 'First paragraph.\n\nSecond.' },
    });
    expect(paragraphs.status()).toBe(200);
    expect((await paragraphs.json()).data.body).toBe(
      'First paragraph.\n\nSecond.',
    );

    const bad = await request.put('admin/content/policies/Bad_Slug', {
      headers,
      data: { title: 'T', body: 'B' },
    });
    expect(bad.status()).toBe(400);
  });
});

test.describe('notification templates', () => {
  test('an edit must keep the placeholders and is audited', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const list = await request.get('admin/content/notification-templates');
    expect(list.status()).toBe(200);
    const welcome = (await list.json()).data.find(
      (t: { key: string; channel: string }) =>
        t.key === 'customer.welcome' && t.channel === 'EMAIL',
    );
    expect(welcome.placeholders).toEqual(['firstName']);

    const opsHeaders = await csrfHeaders(request);
    const opsEdit = await request.put(
      'admin/content/notification-templates/customer.welcome',
      {
        headers: opsHeaders,
        data: {
          channel: 'EMAIL',
          subject: 'Hi',
          body: 'Hi {{firstName}}',
          isActive: true,
        },
      },
    );
    expect(opsEdit.status()).toBe(403);

    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);
    const url = 'admin/content/notification-templates/customer.welcome';

    const dropped = await request.put(url, {
      headers,
      data: {
        channel: 'EMAIL',
        subject: 'Hi',
        body: 'Hello there.',
        isActive: true,
      },
    });
    expect(dropped.status()).toBe(400);
    expect((await dropped.json()).error.code).toBe('VALIDATION_ERROR');

    const unknown = await request.put(url, {
      headers,
      data: {
        channel: 'EMAIL',
        subject: 'Hi',
        body: '{{firstName}} {{nope}}',
        isActive: true,
      },
    });
    expect(unknown.status()).toBe(400);

    const body = `Welcome aboard, {{firstName}}. ${randomUUID()}`;
    const ok = await request.put(url, {
      headers,
      data: {
        channel: 'EMAIL',
        subject: 'Welcome aboard',
        body,
        isActive: true,
      },
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).data).toMatchObject({ body, stored: true });

    const missing = await request.put(
      'admin/content/notification-templates/no.such_key',
      {
        headers,
        data: { channel: 'EMAIL', subject: 'x', body: 'x', isActive: true },
      },
    );
    expect(missing.status()).toBe(404);

    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirst({
        where: {
          entityType: 'NotificationTemplate',
          entityId: 'customer.welcome:EMAIL',
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(audit?.after).toMatchObject({ body });
    expect(audit?.before).toHaveProperty('body');

    // Put the built-in wording back for the other suites.
    await request.put(url, {
      headers,
      data: {
        channel: 'EMAIL',
        subject: 'Welcome to Flyviman',
        body: 'Hello {{firstName}}, your Flyviman account is ready.',
        isActive: true,
      },
    });
  });
});

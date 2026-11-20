import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { csrfHeaders, signIn } from './support/session.js';

/** Public banners and questions: published items only, plain text, cacheable. */
for (const [route, admin] of [
  ['content/banners', 'admin/content/banners'],
  ['content/faqs', 'admin/content/faqs'],
] as const) {
  test(`${route} lists published items only, with cache headers`, async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const headers = await csrfHeaders(request);
    const stamp = randomUUID();
    const make = async (title: string, published: boolean) => {
      const created = await request.post(admin, {
        headers,
        data: {
          title: `${title} ${stamp}`,
          body: 'Plain <b>text</b>',
          published,
        },
      });
      expect(created.status()).toBe(201);
      return (await created.json()).data.id as string;
    };
    const live = await make('Live', true);
    const draft = await make('Draft', false);
    try {
      const response = await request.get(route);
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toContain('public');
      expect(response.headers()['ratelimit-limit']).toBeDefined();
      const items = (await response.json()).data as {
        id: string;
        title: string;
        body: string;
      }[];
      const ids = items.map((item) => item.id);
      expect(ids).toContain(live);
      expect(ids).not.toContain(draft);
      const item = items.find((entry) => entry.id === live)!;
      // Only what a visitor needs; the text is returned as stored, not as HTML.
      expect(Object.keys(item).sort()).toEqual(['body', 'id', 'title']);
      expect(item.body).toBe('Plain <b>text</b>');

      // Unpublishing removes it at once.
      await request.patch(`${admin}/${live}`, {
        headers,
        data: { published: false },
      });
      const after = (await (await request.get(route)).json()).data as {
        id: string;
      }[];
      expect(after.map((entry) => entry.id)).not.toContain(live);
    } finally {
      for (const id of [live, draft]) {
        await request.delete(`${admin}/${id}`, { headers });
      }
    }
  });
}

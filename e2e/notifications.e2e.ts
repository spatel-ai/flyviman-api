import { expect, test } from '@playwright/test';
import { outbox, registerCustomer } from './support/data.js';

test.describe('email notifications', () => {
  test('a hostile value supplied by a customer is escaped in the HTML part', async ({
    request,
  }) => {
    const firstName = '<script>alert(1)</script><img src=x onerror="y">';
    const { email } = await registerCustomer(request, { firstName });

    const welcome = (await outbox(request, email)).find(
      // The wording may have been edited (admin-content.e2e.ts); the name is always in it.
      (message) => message.body.includes(firstName),
    ) as { body: string; html?: string } | undefined;
    expect(welcome, 'the welcome email was sent').toBeTruthy();
    // The plain-text part keeps the name as typed; the HTML part escapes it.
    expect(welcome!.body).toContain(firstName);
    expect(welcome!.html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;y&quot;&gt;',
    );
    expect(welcome!.html).not.toMatch(/<(?!br>)/);
  });
});

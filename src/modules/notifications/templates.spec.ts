import { EVENT_VARIABLES } from './event-templates.js';
import { NOTIFICATION_MATRIX } from './matrix.js';
import {
  DEFAULT_TEMPLATES,
  oneLine,
  placeholdersOf,
  render,
  toEmailHtml,
} from './templates.js';

describe('render', () => {
  it('fills placeholders and blanks unknown ones', () => {
    expect(
      render('Hi {{ name }}, code {{code}}{{missing}}.', {
        name: 'Asha',
        code: 123456,
      }),
    ).toBe('Hi Asha, code 123456.');
  });

  it('writes a stored ISO timestamp as India time, never the raw value', () => {
    const text = render('Review it before {{validUntil}}.', {
      validUntil: '2026-11-24T06:40:43.598Z',
    });
    expect(text).toBe('Review it before 24 Nov 2026, 12:10 pm IST.');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('has one definition per key and channel', () => {
    const ids = DEFAULT_TEMPLATES.map((t) => `${t.key}:${t.channel}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every email a subject', () => {
    for (const template of DEFAULT_TEMPLATES.filter(
      (t) => t.channel === 'EMAIL',
    )) {
      expect(template.subject, template.key).toBeTruthy();
    }
  });
});

describe('toEmailHtml', () => {
  it('escapes a hostile value interpolated into a template', () => {
    const body = render('Hello {{firstName}}, welcome.', {
      firstName: '<script>alert("x")</script> & <img src=x onerror=\'y\'>',
    });
    expect(toEmailHtml(body)).toBe(
      'Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; ' +
        '&lt;img src=x onerror=&#39;y&#39;&gt;, welcome.',
    );
  });

  it('escapes markup written into a staff-edited template body', () => {
    const html = toEmailHtml(
      render('<a href="javascript:steal()">Hi</a> {{firstName}}\nBye', {
        firstName: 'Asha',
      }),
    );
    expect(html).not.toMatch(/<(?!br>)/);
    expect(html).toBe(
      '&lt;a href=&quot;javascript:steal()&quot;&gt;Hi&lt;/a&gt; Asha<br>\nBye',
    );
  });
});

describe('oneLine', () => {
  it('keeps a subject to one header line', () => {
    expect(
      oneLine(render('Re {{operatorName}}', { operatorName: 'A\r\nBcc: x@y' })),
    ).toBe('Re A Bcc: x@y');
  });

  it('replaces other control characters and U+2028/U+2029 with one space', () => {
    expect(oneLine('a\u0000b\tc\u2028d\u2029e\u0085f\u007fg')).toBe(
      'a b c d e f g',
    );
  });
});

describe('the notification matrix templates', () => {
  const find = (key: string, channel: string) =>
    DEFAULT_TEMPLATES.find((t) => t.key === key && t.channel === channel);
  const hostile = '<script>alert("x")</script> &   {{link}}';
  const variables = {
    reference: hostile,
    link: 'https://flyviman.test/x',
    validUntil: hostile,
    decision: hostile,
  };

  it('has a template for every event and channel the matrix can use', () => {
    for (const rule of NOTIFICATION_MATRIX) {
      for (const channel of rule.channels) {
        expect(find(rule.key, channel), `${rule.key} ${channel}`).toBeDefined();
      }
    }
  });

  it('uses only system-derived variables, never an amount or free text', () => {
    for (const rule of NOTIFICATION_MATRIX) {
      for (const channel of rule.channels) {
        const template = find(rule.key, channel)!;
        for (const name of [
          ...placeholdersOf(template.subject),
          ...placeholdersOf(template.body),
        ]) {
          expect(
            EVENT_VARIABLES,
            `${rule.key} ${channel} {{${name}}}`,
          ).toContain(name);
        }
      }
    }
  });

  it('escapes a hostile value in every email and keeps a subject to one line', () => {
    for (const rule of NOTIFICATION_MATRIX) {
      const template = find(rule.key, 'EMAIL')!;
      const html = toEmailHtml(render(template.body, variables));
      expect(html, rule.key).not.toMatch(/<(?!br>)/);
      expect(html, rule.key).toContain('&lt;script&gt;');
      const subject = oneLine(render(template.subject ?? '', variables));
      expect(subject.includes('\n') || subject.includes('\u2028')).toBe(false);
    }
  });

  it('keeps text messages short and gives each the reference and the link', () => {
    for (const rule of NOTIFICATION_MATRIX) {
      for (const channel of ['SMS', 'WHATSAPP'] as const) {
        const template = find(rule.key, channel);
        if (!template) continue;
        const text = render(template.body, {
          reference: 'FV-ABC123',
          link: 'https://flyviman.test/account/trips/FV-ABC123',
          validUntil: '21 Nov, 18:00',
        });
        expect(text, rule.key).toContain('FV-ABC123');
        expect(text, rule.key).toContain('https://');
        expect(text.length, rule.key).toBeLessThan(320);
      }
    }
  });

  it('never says a payment confirms a booking (rule 2)', () => {
    for (const key of ['payment.succeeded', 'payment.failed']) {
      for (const channel of ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'] as const) {
        const template = find(key, channel);
        if (!template) continue;
        expect(`${template.subject} ${template.body}`, key).not.toMatch(
          /\b(is|has been|are) confirmed(?! only)/i,
        );
      }
    }
  });

  it('points every air ambulance message to emergency services (rule 7)', () => {
    for (const rule of NOTIFICATION_MATRIX.filter(
      (r) => r.key.startsWith('air_ambulance.') && r.audience === 'CUSTOMER',
    )) {
      for (const channel of rule.channels) {
        expect(find(rule.key, channel)!.body, `${rule.key} ${channel}`).toMatch(
          /emergency/i,
        );
      }
    }
  });
});

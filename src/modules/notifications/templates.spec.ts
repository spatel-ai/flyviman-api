import {
  DEFAULT_TEMPLATES,
  oneLine,
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
});

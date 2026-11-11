import { DEFAULT_TEMPLATES, render } from './templates.js';

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

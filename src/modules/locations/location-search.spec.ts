import {
  escapeLike,
  looksLikeCode,
  normaliseSearchTerm,
} from './location-search.js';

describe('looksLikeCode', () => {
  it.each(['BOM', 'bom', 'VABB', 'vab'])('treats %s as a code', (term) => {
    expect(looksLikeCode(term)).toBe(true);
  });

  it.each(['v', 'va', 'mumbai', 'BO1', 'VA BB'])(
    'does not treat %s as a code',
    (term) => {
      expect(looksLikeCode(term)).toBe(false);
    },
  );
});

describe('escapeLike', () => {
  it('makes LIKE wildcards and the escape character literal', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Navi Mumbai')).toBe('Navi Mumbai');
  });
});

describe('normaliseSearchTerm', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseSearchTerm('  navi   mumbai ')).toBe('navi mumbai');
  });

  it('treats an empty or blank term as no term', () => {
    expect(normaliseSearchTerm(undefined)).toBeNull();
    expect(normaliseSearchTerm('   ')).toBeNull();
  });
});

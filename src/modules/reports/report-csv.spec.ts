import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './report-csv.js';

describe('csvCell', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tcmd', '\rcmd'])(
    'neutralises text that a spreadsheet would run as a formula: %j',
    (text) => {
      expect(csvCell(text).replace(/^"/, '')).toMatch(/^'/);
    },
  );

  it('keeps numbers as numbers, so a negative amount is not text', () => {
    expect(csvCell(-500)).toBe('-500');
  });

  it('quotes commas, quotes and line breaks and doubles inner quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it('writes null as an empty cell', () => {
    expect(csvCell(null)).toBe('');
  });
});

describe('toCsv', () => {
  it('starts with the long-form header and neutralises a formula in a dimension', () => {
    const csv = toCsv({
      byOperator: [{ operatorName: '=HYPERLINK("x")', requests: 3 }],
    });
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('section,dimension,metric,currency,value');
    expect(row).toBe('byOperator,"\'=HYPERLINK(""x"")",requests,,3');
  });

  it('writes money with its currency in paise', () => {
    const csv = toCsv({ collected: [{ currency: 'INR', amountMinor: 12345 }] });
    expect(csv.split('\r\n')[1]).toBe('collected,,,INR,12345');
  });
});

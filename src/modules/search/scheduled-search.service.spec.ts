import { AppException } from '../../common/errors/app.exception.js';
import { checkDates, checkParty } from './scheduled-search.service.js';

function field(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    return (error as AppException).details[0]?.field;
  }
  return undefined;
}

describe('checkDates', () => {
  const today = '2026-12-01';
  it('accepts today, a later return and the last day of the year ahead', () => {
    expect(
      field(() => checkDates({ departureDate: today }, today)),
    ).toBeUndefined();
    expect(
      field(() =>
        checkDates({ departureDate: today, returnDate: today }, today),
      ),
    ).toBeUndefined();
    expect(
      field(() => checkDates({ departureDate: '2027-12-01' }, today)),
    ).toBeUndefined();
  });

  it('refuses the past, beyond a year and a return before departure', () => {
    expect(
      field(() => checkDates({ departureDate: '2026-11-30' }, today)),
    ).toBe('departureDate');
    expect(
      field(() => checkDates({ departureDate: '2027-12-02' }, today)),
    ).toBe('departureDate');
    expect(
      field(() =>
        checkDates(
          { departureDate: '2026-12-05', returnDate: '2026-12-04' },
          today,
        ),
      ),
    ).toBe('returnDate');
    expect(
      field(() =>
        checkDates(
          { departureDate: '2026-12-05', returnDate: '2027-12-02' },
          today,
        ),
      ),
    ).toBe('returnDate');
  });
});

describe('checkParty', () => {
  it('allows nine seats and one infant per adult', () => {
    expect(
      field(() => checkParty({ adults: 5, children: 4, infants: 5 })),
    ).toBeUndefined();
  });

  it('refuses ten seats or more infants than adults', () => {
    expect(
      field(() => checkParty({ adults: 2, children: 8, infants: 0 })),
    ).toBe('passengers.children');
    expect(
      field(() => checkParty({ adults: 1, children: 0, infants: 2 })),
    ).toBe('passengers.infants');
  });
});

import { changedFields } from './location-changes.js';

const current = {
  name: 'Juhu Aerodrome',
  iata: null as string | null,
  capabilities: { runwayLengthM: 1143, nightOperations: null },
  isActive: true,
};

describe('changedFields', () => {
  it('returns only the fields whose values change, both sides', () => {
    expect(
      changedFields(current, {
        name: 'Juhu Aerodrome',
        iata: 'JUH',
        isActive: false,
      }),
    ).toEqual({
      before: { iata: null, isActive: true },
      after: { iata: 'JUH', isActive: false },
    });
  });

  it('compares nested objects by value', () => {
    expect(
      changedFields(current, {
        capabilities: { runwayLengthM: 1143, nightOperations: null },
      }),
    ).toEqual({ before: {}, after: {} });
    expect(
      changedFields(current, {
        capabilities: { runwayLengthM: 1200, nightOperations: null },
      }).after,
    ).toEqual({ capabilities: { runwayLengthM: 1200, nightOperations: null } });
  });

  it('ignores fields left out, but records a change to null', () => {
    const coded = { ...current, iata: 'BOM' as string | null };
    expect(changedFields(coded, { iata: null })).toEqual({
      before: { iata: 'BOM' },
      after: { iata: null },
    });
    expect(changedFields(current, { iata: undefined })).toEqual({
      before: {},
      after: {},
    });
  });
});

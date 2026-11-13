import { describe, expect, it } from 'vitest';
import { searchBlockers } from './aircraft-search.js';

const live = {
  listingStatus: 'APPROVED',
  availabilityStatus: 'AVAILABLE',
  operatorStatus: 'APPROVED',
  missing: [],
} as const;

describe('searchBlockers', () => {
  it('is empty for an approved, available aircraft with current documents', () => {
    expect(searchBlockers({ ...live, missing: [] })).toEqual([]);
  });

  it('names every reason, statuses first', () => {
    expect(
      searchBlockers({
        listingStatus: 'SUSPENDED',
        availabilityStatus: 'MAINTENANCE',
        operatorStatus: 'SUSPENDED',
        missing: ['document:INSURANCE'],
      }),
    ).toEqual([
      'listingNotApproved',
      'operatorNotApproved',
      'notAvailable',
      'document:INSURANCE',
    ]);
  });

  it('takes an aircraft out of search when a required document has expired', () => {
    expect(
      searchBlockers({ ...live, missing: ['document:AIRWORTHINESS'] }),
    ).toEqual(['document:AIRWORTHINESS']);
  });
});

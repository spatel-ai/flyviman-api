import { AirlineProviderError } from './airline.provider.js';
import { MockAirlineProvider } from './mock-airline.provider.js';

const provider = new MockAirlineProvider();
const base = {
  origin: 'DEL',
  destination: 'BOM',
  departDate: '2027-03-10',
  adults: 2,
};

async function allOffers() {
  const found = [];
  for (let day = 1; day <= 28; day += 1) {
    const departDate = `2027-04-${String(day).padStart(2, '0')}`;
    const r = await provider.searchFares({ ...base, departDate, adults: 1 });
    found.push(...r.outbound);
  }
  return found;
}

describe('MockAirlineProvider', () => {
  it('searches a one-way trip with realistic, labelled fares', async () => {
    const result = await provider.searchFares(base);
    expect(result.inbound).toBeNull();
    expect(result.outbound.length).toBeGreaterThan(3);
    for (const o of result.outbound) {
      expect(o.origin).toBe('DEL');
      expect(o.destination).toBe('BOM');
      expect(o.currency).toBe('INR');
      expect(o.priceType).toBe('LIVE_FARE');
      expect(Number.isInteger(o.fareMinor)).toBe(true);
      expect(o.fareMinor).toBeGreaterThan(300000);
      expect(o.fareMinor).toBeLessThan(3000000);
      expect(o.totalMinor).toBe(o.fareMinor * 2);
      expect(o.seatsLeft).toBeGreaterThanOrEqual(2);
      expect(o.durationMinutes).toBeGreaterThan(90);
      expect(o.durationMinutes).toBeLessThan(200);
      expect(Date.parse(o.arrivalAt) - Date.parse(o.departureAt)).toBe(
        o.durationMinutes * 60000,
      );
    }
    const times = result.outbound.map((o) => o.departureAt);
    expect([...times].sort()).toEqual(times);
  });

  it('searches a return trip with both legs', async () => {
    const result = await provider.searchFares({
      ...base,
      returnDate: '2027-03-14',
    });
    expect(result.outbound.length).toBeGreaterThan(0);
    expect(result.inbound?.length).toBeGreaterThan(0);
    expect(result.inbound?.[0].origin).toBe('BOM');
    expect(result.inbound?.[0].departureAt.startsWith('2027-03-1')).toBe(true);
  });

  it('is deterministic for the same seed and differs for another', async () => {
    const again = await new MockAirlineProvider().searchFares(base);
    expect(again).toEqual(await provider.searchFares(base));
    const other = await new MockAirlineProvider('other').searchFares(base);
    expect(other).not.toEqual(again);
  });

  it('returns nothing for a route it does not serve and rejects bad queries', async () => {
    const none = await provider.searchFares({
      ...base,
      origin: 'GOI',
      destination: 'JAI',
    });
    expect(none.outbound).toEqual([]);
    for (const bad of [
      { ...base, origin: 'XXX' },
      { ...base, destination: 'DEL' },
      { ...base, departDate: '2027-02-30' },
      { ...base, returnDate: '2027-03-01' },
      { ...base, adults: 0 },
      { ...base, adults: 10 },
    ]) {
      await expect(provider.searchFares(bad)).rejects.toBeInstanceOf(
        AirlineProviderError,
      );
    }
  });

  it('never lists an offer with fewer seats than passengers', async () => {
    const r = await provider.searchFares({ ...base, adults: 9 });
    for (const o of r.outbound) expect(o.seatsLeft).toBeGreaterThanOrEqual(9);
  });

  it('revalidates to available, price changed and sold out across offers', async () => {
    const statuses = new Set<string>();
    for (const o of await allOffers()) {
      const r = await provider.revalidate(o.offerId, 1, o.totalMinor);
      statuses.add(r.status);
      if (r.status === 'SOLD_OUT') {
        expect(r.offer).toBeNull();
        expect(r.currentTotalMinor).toBeNull();
      } else if (r.status === 'PRICE_CHANGED') {
        expect(r.currentTotalMinor).toBeGreaterThan(o.totalMinor);
        expect(r.offer?.priceType).toBe('LIVE_FARE');
      } else {
        expect(r.currentTotalMinor).toBe(o.totalMinor);
      }
      expect(await provider.revalidate(o.offerId, 1, o.totalMinor)).toEqual(r);
    }
    expect(statuses).toEqual(
      new Set(['AVAILABLE', 'PRICE_CHANGED', 'SOLD_OUT']),
    );
  });

  it('reports a changed price when the shown total is stale', async () => {
    const [o] = (await provider.searchFares(base)).outbound;
    const r = await provider.revalidate(o.offerId, 2, 1);
    expect(['PRICE_CHANGED', 'SOLD_OUT']).toContain(r.status);
  });

  it('returns fare rules with cancellation conditions', async () => {
    const { outbound } = await provider.searchFares(base);
    const saver = outbound.find((o) => o.fareFamily === 'SAVER')!;
    const flexi = outbound.find((o) => o.fareFamily === 'FLEXI')!;
    const s = await provider.getFareRules(saver.offerId);
    const f = await provider.getFareRules(flexi.offerId);
    expect(s.refundable).toBe(false);
    expect(s.cancellationFeeMinor).toBeNull();
    expect(f.refundable).toBe(true);
    expect(f.conditions.length).toBeGreaterThan(0);
    expect(flexi.fareMinor).toBeGreaterThan(0);
  });

  it('rejects an unknown or forged offer id', async () => {
    await expect(provider.getFareRules('nope')).rejects.toBeInstanceOf(
      AirlineProviderError,
    );
    const forged = Buffer.from(
      JSON.stringify({
        c: '6E',
        n: 101,
        o: 'DEL',
        d: 'BOM',
        t: '2027-03-10',
        f: 'SAVER',
      }),
    ).toString('base64url');
    await expect(provider.revalidate(forged, 1, 1)).rejects.toBeInstanceOf(
      AirlineProviderError,
    );
  });
});

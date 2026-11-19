import {
  AirlineInventoryProvider,
  AirlineProviderError,
  FareFamily,
  FareOffer,
  FareRules,
  FareSearchQuery,
  FareSearchResult,
  PartySize,
  RevalidationResult,
} from './airline.provider.js';

/** What the mock does for one route, set from the development tools. */
export type MockAirlineBehaviour = 'NORMAL' | 'TIMEOUT' | 'ERROR';

/**
 * Deterministic mock of an Indian domestic airline supplier. Fares, times
 * and availability depend only on the route, the date, the flight and the
 * seed, so a test gets the same answer every run. No network, no clock.
 *
 * Offer ids are stateless: they carry what is needed to rebuild the offer.
 * Some offers are made to turn sold out or change price on revalidation
 * (again by hash), so the checkout paths can be exercised.
 */
const TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MINUTES = 330;

const AIRPORTS: Record<string, { lat: number; lon: number }> = {
  DEL: { lat: 28.55563, lon: 77.09519 },
  BOM: { lat: 19.088699, lon: 72.867897 },
  BLR: { lat: 13.1979, lon: 77.706299 },
  HYD: { lat: 17.231318, lon: 78.429855 },
  MAA: { lat: 12.990005, lon: 80.169296 },
  CCU: { lat: 22.654012, lon: 88.44765 },
  GOI: { lat: 15.380062, lon: 73.833328 },
  AMD: { lat: 23.0772, lon: 72.634697 },
  PNQ: { lat: 18.5821, lon: 73.919701 },
  COK: { lat: 10.151047, lon: 76.400838 },
  JAI: { lat: 26.8242, lon: 75.812202 },
  LKO: { lat: 26.760599, lon: 80.889297 },
};

const METROS = ['DEL', 'BOM', 'BLR', 'HYD', 'MAA', 'CCU'];
const SPOKES: Record<string, string[]> = {
  GOI: ['DEL', 'BOM', 'BLR', 'HYD'],
  AMD: ['DEL', 'BOM', 'BLR', 'HYD', 'CCU'],
  PNQ: ['DEL', 'BLR', 'HYD', 'CCU'],
  COK: ['DEL', 'BOM', 'BLR', 'HYD', 'MAA'],
  JAI: ['DEL', 'BOM', 'BLR', 'HYD'],
  LKO: ['DEL', 'BOM', 'BLR', 'CCU'],
};

const CARRIERS = [
  { code: '6E', name: 'IndiGo', premium: 1 },
  { code: 'AI', name: 'Air India', premium: 1.12 },
  { code: 'QP', name: 'Akasa Air', premium: 0.96 },
  { code: 'SG', name: 'SpiceJet', premium: 0.94 },
];

/** Local departure slots, minutes after midnight. */
const SLOTS = [345, 430, 515, 610, 740, 865, 990, 1105, 1215, 1320];

const FAMILIES: Record<
  FareFamily,
  {
    multiplier: number;
    checkedKg: number;
    refundable: boolean;
    cancelFee: number | null;
    changeFee: number | null;
  }
> = {
  SAVER: {
    multiplier: 1,
    checkedKg: 15,
    refundable: false,
    cancelFee: null,
    changeFee: 350000,
  },
  FLEXI: {
    multiplier: 1.35,
    checkedKg: 25,
    refundable: true,
    cancelFee: 300000,
    changeFee: 0,
  },
};

const FAMILY_CODES = Object.keys(FAMILIES) as FareFamily[];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_CHANGE_MARKER = 5;
/** Per infant on a lap, whatever the fare: a flat fee, as Indian carriers charge. */
const INFANT_FEE_MINOR = 150000;
const SOLD_OUT_MARKER = 11;

/** FNV-1a, 32 bit: a stable hash with no dependency. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function haversineKm(a: string, b: string): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const p = AIRPORTS[a];
  const q = AIRPORTS[b];
  const dLat = rad(q.lat - p.lat);
  const dLon = rad(q.lon - p.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

function isServed(origin: string, destination: string): boolean {
  const pair = (a: string, b: string) =>
    (METROS.includes(a) && METROS.includes(b)) || SPOKES[a]?.includes(b);
  return (
    origin !== destination &&
    Boolean(pair(origin, destination) || pair(destination, origin))
  );
}

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

interface OfferKey {
  c: string;
  n: number;
  o: string;
  d: string;
  t: string;
  f: FareFamily;
}

function encodeKey(key: OfferKey): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeKey(offerId: string): OfferKey {
  try {
    const key = JSON.parse(
      Buffer.from(offerId, 'base64url').toString('utf8'),
    ) as OfferKey;
    const carrier = CARRIERS.some((c) => c.code === key.c);
    if (
      carrier &&
      Number.isInteger(key.n) &&
      isServed(key.o, key.d) &&
      isRealDate(key.t) &&
      FAMILY_CODES.includes(key.f)
    ) {
      return key;
    }
  } catch {
    // fall through
  }
  throw new AirlineProviderError('INVALID_OFFER', 'Unknown fare offer.');
}

/** Provider errors reach callers as rejections, as a real supplier's would. */
function settle<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

interface Party {
  adults: number;
  children: number;
  infants: number;
}

export class MockAirlineProvider extends AirlineInventoryProvider {
  /** Simulated failures by `ORIGIN-DESTINATION`, for tests (development tools). */
  private readonly behaviours = new Map<string, MockAirlineBehaviour>();

  constructor(private readonly seed = 'flyviman') {
    super();
  }

  /**
   * Makes searches from `origin` to `destination` time out (never answer)
   * or fail, or answer normally again. Scoped to the route so that tests
   * running in parallel on other routes are not affected.
   */
  simulate(
    origin: string,
    destination: string,
    behaviour: MockAirlineBehaviour,
  ): void {
    const key = `${origin.toUpperCase()}-${destination.toUpperCase()}`;
    if (behaviour === 'NORMAL') this.behaviours.delete(key);
    else this.behaviours.set(key, behaviour);
  }

  searchFares(query: FareSearchQuery): Promise<FareSearchResult> {
    const key = `${String(query.origin).toUpperCase()}-${String(query.destination).toUpperCase()}`;
    const behaviour = this.behaviours.get(key);
    if (behaviour === 'TIMEOUT') return new Promise(() => undefined);
    if (behaviour === 'ERROR') {
      return Promise.reject(new Error('Mock supplier failure.'));
    }
    return settle(() => this.search(query));
  }

  revalidate(
    offerId: string,
    party: PartySize,
    previousTotalMinor: number,
  ): Promise<RevalidationResult> {
    return settle(() => this.recheck(offerId, party, previousTotalMinor));
  }

  getFareRules(offerId: string): Promise<FareRules> {
    return settle(() => this.rules(offerId));
  }

  private recheck(
    offerId: string,
    partySize: PartySize,
    previousTotalMinor: number,
  ): RevalidationResult {
    const key = decodeKey(offerId);
    const party = this.checkParty(partySize);
    const base = this.build(key, party);
    const h = hash(`${this.seed}|reval|${offerId}`);
    const gone = base.seatsLeft < seats(party) || h % SOLD_OUT_MARKER === 0;
    if (gone) {
      return {
        status: 'SOLD_OUT',
        offer: null,
        previousTotalMinor,
        currentTotalMinor: null,
        currency: 'INR',
      };
    }
    // Every few offers the fare moves by 3 to 12 percent on revalidation.
    let offer = base;
    if (h % PRICE_CHANGE_MARKER === 0) {
      const pct = 3 + (h % 10);
      const fareMinor = this.round(base.fareMinor * (1 + pct / 100));
      offer = { ...base, fareMinor, totalMinor: total(fareMinor, party) };
    }
    const changed = offer.totalMinor !== previousTotalMinor;
    return {
      status: changed ? 'PRICE_CHANGED' : 'AVAILABLE',
      offer,
      previousTotalMinor,
      currentTotalMinor: offer.totalMinor,
      currency: 'INR',
    };
  }

  private rules(offerId: string): FareRules {
    const key = decodeKey(offerId);
    const family = FAMILIES[key.f];
    const baggage = { cabinKg: 7, checkedKg: family.checkedKg };
    const conditions = [
      {
        title: 'Baggage',
        text: `Cabin baggage ${baggage.cabinKg} kg, checked baggage ${baggage.checkedKg} kg per passenger.`,
      },
      {
        title: 'Cancellation',
        text: family.refundable
          ? 'Refundable up to 4 hours before departure; a cancellation fee applies per passenger.'
          : 'Non-refundable. Taxes may be refunded by the airline on cancellation.',
      },
      {
        title: 'Changes',
        text: family.changeFee
          ? 'Date or time changes are allowed up to 4 hours before departure for a change fee plus any fare difference.'
          : 'Date or time changes are free up to 4 hours before departure; any fare difference is payable.',
      },
    ];
    return {
      offerId,
      refundable: family.refundable,
      cancellationFeeMinor: family.cancelFee,
      changeFeeMinor: family.changeFee,
      cancellationCutoffHours: 4,
      baggage,
      conditions,
    };
  }

  private search(query: FareSearchQuery): FareSearchResult {
    const party = this.checkParty(query);
    const origin = query.origin?.toUpperCase();
    const destination = query.destination?.toUpperCase();
    for (const code of [origin, destination]) {
      if (!AIRPORTS[code]) {
        throw new AirlineProviderError(
          'INVALID_QUERY',
          `Unsupported airport: ${String(code)}.`,
        );
      }
    }
    if (origin === destination) {
      throw new AirlineProviderError(
        'INVALID_QUERY',
        'Origin and destination must differ.',
      );
    }
    if (!isRealDate(query.departDate)) {
      throw new AirlineProviderError('INVALID_QUERY', 'Invalid departDate.');
    }
    if (query.returnDate !== undefined) {
      if (
        !isRealDate(query.returnDate) ||
        query.returnDate < query.departDate
      ) {
        throw new AirlineProviderError('INVALID_QUERY', 'Invalid returnDate.');
      }
    }
    // The mock's carriers sell economy only on these routes.
    const economy = (query.cabin ?? 'ECONOMY') === 'ECONOMY';
    return {
      outbound: economy
        ? this.flights(origin, destination, query.departDate, party)
        : [],
      inbound:
        query.returnDate === undefined
          ? null
          : economy
            ? this.flights(destination, origin, query.returnDate, party)
            : [],
    };
  }

  private checkParty(size: PartySize): Party {
    const { adults, children = 0, infants = 0 } = size;
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) {
      throw new AirlineProviderError('INVALID_QUERY', 'Adults must be 1 to 9.');
    }
    if (!Number.isInteger(children) || children < 0 || adults + children > 9) {
      throw new AirlineProviderError(
        'INVALID_QUERY',
        'Adults and children together must be 1 to 9.',
      );
    }
    if (!Number.isInteger(infants) || infants < 0 || infants > adults) {
      throw new AirlineProviderError(
        'INVALID_QUERY',
        'Infants must be 0 to the number of adults.',
      );
    }
    return { adults, children, infants };
  }

  private flights(
    origin: string,
    destination: string,
    date: string,
    party: Party,
  ): FareOffer[] {
    if (!isServed(origin, destination)) return [];
    const offers: FareOffer[] = [];
    const route = `${this.seed}|${[origin, destination].sort().join('')}`;
    for (const [index, slot] of SLOTS.entries()) {
      const h = hash(`${route}|${origin}|${index}`);
      // Not every slot is operated, and which ones vary by day.
      if (hash(`${h}|${date}`) % 4 === 0) continue;
      const carrier = CARRIERS[h % CARRIERS.length];
      const key = {
        c: carrier.code,
        n: 100 + (h % 90) * 10 + index,
        o: origin,
        d: destination,
        t: date,
      };
      const minute = slot + (h % 4) * 5;
      for (const f of FAMILY_CODES) {
        const offer = this.build({ ...key, t: date, f }, party, minute);
        // A sold-out fare is not bookable, so it is not listed (rule 4).
        if (offer.seatsLeft >= seats(party)) offers.push(offer);
      }
    }
    return offers.sort((a, b) => a.departureAt.localeCompare(b.departureAt));
  }

  private build(key: OfferKey, party: Party, minute?: number): FareOffer {
    const carrier = CARRIERS.find((c) => c.code === key.c)!;
    const family = FAMILIES[key.f];
    const departMinute = minute ?? this.findMinute(key);
    const km = haversineKm(key.o, key.d);
    const durationMinutes = Math.round((50 + (km / 760) * 60) / 5) * 5;
    const departUtc =
      Date.parse(`${key.t}T00:00:00Z`) +
      (departMinute - IST_OFFSET_MINUTES) * 60000;
    const day = hash(`${this.seed}|${key.c}${key.n}|${key.t}`);
    const dayFactor = 0.9 + (day % 40) / 100;
    const peak =
      departMinute < 600 || (departMinute > 1020 && departMinute < 1200);
    const base = 220000 + km * 480;
    const fareMinor = this.round(
      base *
        carrier.premium *
        family.multiplier *
        dayFactor *
        (peak ? 1.12 : 1),
    );
    return {
      offerId: encodeKey(key),
      carrierCode: carrier.code,
      carrierName: carrier.name,
      flightNumber: `${carrier.code} ${key.n}`,
      origin: key.o,
      destination: key.d,
      departureAt: new Date(departUtc).toISOString(),
      arrivalAt: new Date(departUtc + durationMinutes * 60000).toISOString(),
      originTimeZone: TIME_ZONE,
      destinationTimeZone: TIME_ZONE,
      durationMinutes,
      stops: 0,
      cabin: 'ECONOMY',
      fareFamily: key.f,
      baggage: { cabinKg: 7, checkedKg: family.checkedKg },
      refundable: family.refundable,
      seatsLeft:
        hash(`${this.seed}|seats|${key.c}${key.n}|${key.t}|${key.f}`) % 10,
      fareMinor,
      totalMinor: total(fareMinor, party),
      currency: 'INR',
      priceType: 'LIVE_FARE',
    };
  }

  /** The flight number's last digit is its slot (see `flights`). */
  private findMinute(key: OfferKey): number {
    const index = key.n % 10;
    const route = `${this.seed}|${[key.o, key.d].sort().join('')}`;
    const h = hash(`${route}|${key.o}|${index}`);
    if (
      key.n < 100 ||
      key.n > 999 ||
      CARRIERS[h % CARRIERS.length].code !== key.c ||
      100 + (h % 90) * 10 + index !== key.n
    ) {
      throw new AirlineProviderError('INVALID_OFFER', 'Unknown fare offer.');
    }
    return SLOTS[index] + (h % 4) * 5;
  }

  /** Whole rupees, as airlines price them. */
  private round(minor: number): number {
    return Math.round(minor / 100) * 100;
  }
}

/** Seats the party needs: infants travel on a lap. */
function seats(party: Party): number {
  return party.adults + party.children;
}

function total(fareMinor: number, party: Party): number {
  return fareMinor * seats(party) + INFANT_FEE_MINOR * party.infants;
}

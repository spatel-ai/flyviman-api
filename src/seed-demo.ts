import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import {
  AircraftCategory,
  AircraftDocumentType,
  AircraftListingStatus,
  AircraftPricingModel,
  AvailabilitySlotKind,
  DocumentVerificationStatus,
  EmptyLegPricingBasis,
  EmptyLegStatus,
  FilePurpose,
  OperatorStatus,
  PricingRuleScope,
  PricingRuleType,
  PromotionKind,
  Role,
  ServiceCategory,
  UserStatus,
  WingType,
} from './generated/prisma/enums.js';
import { hashPassword } from './common/crypto/password.js';
import { emptyLegReference } from './common/reference.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

/**
 * Demo data for a manual test of the whole product: one account per role, an
 * approved operator with aircraft, rates and open time, a promotion code and
 * an empty leg. Run after the base seed (`npm run seed:demo` does both).
 * Safe to run again: rows are found by a stable key and left alone, except
 * the demo passwords and the open time, which are reset so the demo always
 * works. Local and test databases only.
 *
 *   npm run seed:demo
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error('The demo data is never seeded in production.');
}

const PASSWORD = 'Flyviman@Demo1';
const OPERATOR_NAME = 'Demo Air Charters';
const DAY = 24 * 60 * 60 * 1000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ||
      (process.env.DATABASE_URL as string),
  }),
});

async function user(email: string, role: Role, passwordHash: string) {
  return prisma.user.upsert({
    where: { email },
    create: {
      email,
      role,
      status: UserStatus.ACTIVE,
      passwordHash,
      emailVerifiedAt: new Date(),
    },
    update: {
      role,
      status: UserStatus.ACTIVE,
      suspendedBy: null,
      passwordHash,
      emailVerifiedAt: new Date(),
    },
  });
}

async function location(iata: string) {
  const row = await prisma.location.findUnique({ where: { iata } });
  if (!row) throw new Error(`Location ${iata} is missing. Run db:seed first.`);
  return row;
}

interface DemoAircraft {
  registration: string;
  manufacturer: string;
  model: string;
  category: AircraftCategory;
  seats: number;
  rangeKm: number;
  speed: number;
  base: string;
  /** Hourly rate in rupees. */
  hourly: number;
}

const AIRCRAFT: DemoAircraft[] = [
  {
    registration: 'VT-DJT',
    manufacturer: 'Cessna',
    model: 'Citation XLS+',
    category: AircraftCategory.MIDSIZE_JET,
    seats: 8,
    rangeKm: 3400,
    speed: 780,
    base: 'DEL',
    hourly: 165000,
  },
  {
    registration: 'VT-DJU',
    manufacturer: 'Embraer',
    model: 'Phenom 300',
    category: AircraftCategory.LIGHT_JET,
    seats: 6,
    rangeKm: 3300,
    speed: 790,
    base: 'BLR',
    hourly: 135000,
  },
  {
    registration: 'VT-DHL',
    manufacturer: 'Airbus Helicopters',
    model: 'H145',
    category: AircraftCategory.HELICOPTER,
    seats: 7,
    rangeKm: 680,
    speed: 240,
    base: 'BOM',
    hourly: 125000,
  },
  {
    registration: 'VT-DAM',
    manufacturer: 'Beechcraft',
    model: 'King Air 350 (air ambulance)',
    category: AircraftCategory.AIR_AMBULANCE_FIXED,
    seats: 4,
    rangeKm: 3300,
    speed: 560,
    base: 'DEL',
    hourly: 110000,
  },
];

async function ensureOperator(adminId: string, staffId: string) {
  const existing = await prisma.operator.findFirst({
    where: { legalName: OPERATOR_NAME },
  });
  const data = {
    legalName: OPERATOR_NAME,
    tradingName: OPERATOR_NAME,
    contactName: 'Demo Operator',
    contactEmail: 'opadmin@demo.flyviman.test',
    serviceCategories: [
      ServiceCategory.PRIVATE_CHARTER,
      ServiceCategory.HELICOPTER,
      ServiceCategory.EMPTY_LEG,
      ServiceCategory.AIR_AMBULANCE,
    ],
    operatingRegions: ['IN'],
    status: OperatorStatus.APPROVED,
    submittedAt: new Date(),
    reviewedAt: new Date(),
    reviewNote: 'Demo operator.',
  };
  const operator = existing
    ? await prisma.operator.update({ where: { id: existing.id }, data })
    : await prisma.operator.create({ data });
  for (const userId of [adminId, staffId]) {
    await prisma.operatorMember.upsert({
      where: { userId },
      create: { operatorId: operator.id, userId },
      update: { operatorId: operator.id },
    });
  }
  return operator;
}

async function ensureAircraft(
  operatorId: string,
  ownerId: string,
  spec: DemoAircraft,
) {
  const base = await location(spec.base);
  const rotary = spec.category === AircraftCategory.HELICOPTER;
  const data = {
    operatorId,
    manufacturer: spec.manufacturer,
    model: spec.model,
    category: spec.category,
    wingType: rotary ? WingType.HELICOPTER : WingType.FIXED_WING,
    passengerCapacity: spec.seats,
    baggageCapacityKg: 200,
    rangeKm: spec.rangeKm,
    cruiseSpeedKmh: spec.speed,
    homeBaseId: base.id,
    currentLocationId: base.id,
    operatingRegions: ['IN'],
    listingStatus: AircraftListingStatus.APPROVED,
    pricingModel: AircraftPricingModel.HOURLY,
    submittedAt: new Date(),
    reviewedAt: new Date(),
    reviewNote: 'Demo aircraft.',
  };
  const aircraft = await prisma.aircraft.upsert({
    where: { registration: spec.registration },
    create: { registration: spec.registration, ...data },
    update: data,
  });

  // The three documents matching requires, each backed by a stored file row.
  const nextYear = new Date(Date.now() + 365 * DAY);
  for (const type of [
    AircraftDocumentType.REGISTRATION,
    AircraftDocumentType.AIRWORTHINESS,
    AircraftDocumentType.INSURANCE,
  ]) {
    const have = await prisma.aircraftDocument.findFirst({
      where: { aircraftId: aircraft.id, type },
    });
    if (have) {
      await prisma.aircraftDocument.update({
        where: { id: have.id },
        data: {
          expiresAt: nextYear,
          verificationStatus: DocumentVerificationStatus.VERIFIED,
        },
      });
      continue;
    }
    const file = await prisma.storedFile.create({
      data: {
        ownerId: ownerId,
        purpose: FilePurpose.AIRCRAFT_DOCUMENT,
        storageKey: `demo/${spec.registration}/${type}.pdf`,
        fileName: `${spec.registration}-${type.toLowerCase()}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 1024,
        uploadedAt: new Date(),
      },
    });
    await prisma.aircraftDocument.create({
      data: {
        aircraftId: aircraft.id,
        type,
        fileId: file.id,
        expiresAt: nextYear,
        verificationStatus: DocumentVerificationStatus.VERIFIED,
        verifiedAt: new Date(),
      },
    });
  }

  // Hourly rate, created once (rules are versioned, never edited here).
  const rate = await prisma.pricingRule.findFirst({
    where: {
      scope: PricingRuleScope.AIRCRAFT,
      scopeRef: aircraft.id,
      type: PricingRuleType.HOURLY_RATE,
      isActive: true,
    },
  });
  if (!rate) {
    await prisma.pricingRule.create({
      data: {
        scope: PricingRuleScope.AIRCRAFT,
        scopeRef: aircraft.id,
        type: PricingRuleType.HOURLY_RATE,
        config: { amountMinor: spec.hourly * 100, currency: 'INR' },
      },
    });
  }

  // Open time for the next 120 days, reset on each run.
  await prisma.availabilitySlot.deleteMany({
    where: { aircraftId: aircraft.id },
  });
  await prisma.availabilitySlot.create({
    data: {
      aircraftId: aircraft.id,
      startsAt: new Date(Date.now() - DAY),
      endsAt: new Date(Date.now() + 120 * DAY),
      kind: AvailabilitySlotKind.OPEN,
    },
  });
  return aircraft;
}

async function ensurePromotion() {
  if (await prisma.promotion.findUnique({ where: { code: 'DEMO10' } })) return;
  await prisma.promotion.create({
    data: {
      code: 'DEMO10',
      name: 'Demo 10% off',
      kind: PromotionKind.PERCENT,
      percentBasisPoints: 1000,
      startsAt: new Date(Date.now() - DAY),
      endsAt: new Date(Date.now() + 365 * DAY),
    },
  });
}

async function ensureEmptyLeg(
  operatorId: string,
  aircraftId: string,
  createdById: string,
) {
  if (
    await prisma.emptyLeg.findFirst({
      where: {
        operatorId,
        aircraftId,
        bookingConditions: { startsWith: 'Demo' },
      },
    })
  ) {
    return;
  }
  const [origin, destination] = await Promise.all([
    location('BOM'),
    location('DEL'),
  ]);
  const start = new Date(Date.now() + 10 * DAY);
  await prisma.emptyLeg.create({
    data: {
      reference: emptyLegReference(),
      aircraftId,
      operatorId,
      originId: origin.id,
      destinationId: destination.id,
      departureWindowStart: start,
      departureWindowEnd: new Date(start.getTime() + 6 * 60 * 60 * 1000),
      passengerCapacity: 6,
      priceMinor: 28000000n,
      pricingBasis: EmptyLegPricingBasis.OPERATOR_PRICE,
      expiresAt: new Date(start.getTime() - DAY),
      bookingConditions: 'Demo offer: one way, the aircraft returns to Delhi.',
      status: EmptyLegStatus.PUBLISHED,
      submittedAt: new Date(),
      publishedAt: new Date(),
      createdById,
    },
  });
}

try {
  const hash = await hashPassword(PASSWORD);
  const customer = await user(
    'customer@demo.flyviman.test',
    Role.CUSTOMER,
    hash,
  );
  await prisma.customerProfile.upsert({
    where: { userId: customer.id },
    create: { userId: customer.id, firstName: 'Demo', lastName: 'Customer' },
    update: {},
  });
  const opAdmin = await user(
    'opadmin@demo.flyviman.test',
    Role.OPERATOR_ADMIN,
    hash,
  );
  const opStaff = await user(
    'opstaff@demo.flyviman.test',
    Role.OPERATOR_STAFF,
    hash,
  );
  await user('ops@demo.flyviman.test', Role.OPS, hash);
  await user('finance@demo.flyviman.test', Role.FINANCE_ADMIN, hash);
  await user('admin@demo.flyviman.test', Role.SUPER_ADMIN, hash);

  const operator = await ensureOperator(opAdmin.id, opStaff.id);
  const made = [];
  for (const spec of AIRCRAFT) {
    made.push(await ensureAircraft(operator.id, opAdmin.id, spec));
  }
  await ensurePromotion();
  await ensureEmptyLeg(operator.id, made[0].id, opAdmin.id);
  console.log('demo data ready: see docs/testing/manual-test-guide.md');
} finally {
  await prisma.$disconnect();
}

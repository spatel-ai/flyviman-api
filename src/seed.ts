import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client.js';
import {
  ContentKind,
  LocationType,
  Role,
  UserStatus,
} from './generated/prisma/enums.js';
import { DEFAULT_TEMPLATES } from './modules/notifications/templates.js';
import { hashPassword, PASSWORD_MIN_LENGTH } from './common/crypto/password.js';

/**
 * Creates the accounts the platform cannot be used without. Safe to run more
 * than once: existing accounts are left alone, passwords included.
 *
 *   npm run db:seed
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

function password(name: string): string {
  const value = required(name);
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new Error(
      `${name} must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    );
  }
  return value;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
});

async function ensureUser(
  email: string,
  role: Role,
  plain: string,
  status: UserStatus = UserStatus.ACTIVE,
) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`exists   ${role.padEnd(14)} ${email}`);
    return;
  }
  await prisma.user.create({
    data: {
      email,
      role,
      status,
      passwordHash: await hashPassword(plain),
      emailVerifiedAt: new Date(),
    },
  });
  console.log(`created  ${role.padEnd(14)} ${email}`);
}

/**
 * Placeholder policies so registration can record consent. The wording must
 * be replaced after legal review (docs/architecture/security-rbac.md).
 */
const POLICIES = [
  {
    slug: 'terms',
    title: 'Terms of use',
    body: 'Placeholder terms of use, pending legal review.\n\nFlyviman is a marketplace that connects customers with aviation operators. Estimates are not confirmed prices. A booking is confirmed only when Flyviman says so in writing.',
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    body: 'Placeholder privacy policy, pending legal review.\n\nWe collect the details needed to arrange your travel and share them only with the operator fulfilling your booking.',
  },
];
const POLICY_VERSION = '2026-11-11';
const SEEDED_OPERATOR_NAME = 'Local Test Aviation Private Limited';

async function ensureContent() {
  for (const policy of POLICIES) {
    const key = { kind: ContentKind.POLICY, slug: policy.slug };
    if (await prisma.contentItem.findUnique({ where: { kind_slug: key } })) {
      continue;
    }
    await prisma.contentItem.create({
      data: {
        ...key,
        title: policy.title,
        body: policy.body,
        version: POLICY_VERSION,
        publishedAt: new Date(),
      },
    });
    console.log(`created  policy         ${policy.slug}`);
  }
  for (const template of DEFAULT_TEMPLATES) {
    const key = { key: template.key, channel: template.channel };
    if (
      await prisma.notificationTemplate.findUnique({
        where: { key_channel: key },
      })
    ) {
      continue;
    }
    await prisma.notificationTemplate.create({
      data: { ...key, subject: template.subject ?? null, body: template.body },
    });
  }
}

interface SeedLocation {
  externalRef: string;
  type: LocationType;
  name: string;
  iata: string | null;
  icao: string | null;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number;
  longitude: number;
  timeZone: string;
  capabilities: Prisma.InputJsonObject;
}

/**
 * Reference airports and heliports (OurAirports, built by
 * scripts/build-locations.mjs). Rows already present are left alone, so
 * changes made by operations are never overwritten.
 */
async function ensureLocations() {
  const file = path.resolve(
    import.meta.dirname,
    '../prisma/data/locations-in.json',
  );
  const { locations } = JSON.parse(await readFile(file, 'utf8')) as {
    locations: SeedLocation[];
  };
  const existing = new Set(
    (
      await prisma.location.findMany({
        where: { externalRef: { not: null } },
        select: { externalRef: true },
      })
    ).map((row) => row.externalRef),
  );
  const missing = locations.filter(
    (location) => !existing.has(location.externalRef),
  );
  if (missing.length === 0) return;
  const { count } = await prisma.location.createMany({
    data: missing,
    skipDuplicates: true,
  });
  console.log(`created  locations      ${count}`);
}

async function ensureCustomerProfile(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.customerProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, firstName: 'Local', lastName: 'Customer' },
    update: {},
  });
}

/** A draft organisation for the local operator administrator. */
async function ensureOperator(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  if (await prisma.operatorMember.findUnique({ where: { userId: user.id } })) {
    return;
  }
  const operator = await prisma.operator.create({
    data: {
      legalName: SEEDED_OPERATOR_NAME,
      contactName: 'Local Operator',
      contactEmail: email,
    },
  });
  await prisma.operatorMember.create({
    data: { operatorId: operator.id, userId: user.id },
  });
  console.log(`created  operator       ${SEEDED_OPERATOR_NAME}`);
}

try {
  await ensureContent();
  await ensureLocations();
  await ensureUser(
    required('SEED_ADMIN_EMAIL').toLowerCase(),
    Role.SUPER_ADMIN,
    password('SEED_ADMIN_PASSWORD'),
  );

  // Local accounts for development and tests, one per role, each with the
  // records a registration would have created.
  if (
    process.env.ENABLE_DEV_TOOLS === 'true' &&
    (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
  ) {
    const local = password('SEED_LOCAL_PASSWORD');
    await ensureUser('customer@flyviman.test', Role.CUSTOMER, local);
    await ensureUser('operator@flyviman.test', Role.OPERATOR_ADMIN, local);
    await ensureUser('ops@flyviman.test', Role.OPS, local);
    await ensureUser('finance@flyviman.test', Role.FINANCE_ADMIN, local);
    await ensureCustomerProfile('customer@flyviman.test');
    await ensureOperator('operator@flyviman.test');
    await ensureUser(
      'suspended@flyviman.test',
      Role.CUSTOMER,
      local,
      UserStatus.SUSPENDED,
    );
  }
} finally {
  await prisma.$disconnect();
}

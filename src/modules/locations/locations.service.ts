import { HttpStatus, Injectable } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import {
  AppException,
  ErrorDetail,
} from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Location } from '../../generated/prisma/client.js';
import type {
  AircraftCategory,
  LocationType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { changedFields } from './location-changes.js';
import {
  escapeLike,
  looksLikeCode,
  normaliseSearchTerm,
} from './location-search.js';

/** `Location.capabilities`; shape in docs/architecture/database-design.md. */
export interface LocationCapabilities {
  /** Null for heliports and where the runway length is unknown. */
  runwayLengthM: number | null;
  /** Null where it is unknown. */
  nightOperations: boolean | null;
  helicopterApproved: boolean;
}

/** The fields anyone may see. Charges and bookkeeping columns are left out. */
export interface PublicLocation {
  id: string;
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
  capabilities: LocationCapabilities;
}

const PUBLIC_SELECT = {
  id: true,
  type: true,
  name: true,
  iata: true,
  icao: true,
  city: true,
  state: true,
  country: true,
  latitude: true,
  longitude: true,
  timeZone: true,
  capabilities: true,
} as const satisfies Prisma.LocationSelect;

const PUBLIC_COLUMNS = Prisma.raw(
  Object.keys(PUBLIC_SELECT)
    .map((column) => `"${column}"`)
    .join(', '),
);

type PublicRow = Omit<PublicLocation, 'capabilities'> & {
  capabilities: Prisma.JsonValue;
};

function toPublic(row: PublicRow): PublicLocation {
  return {
    ...row,
    capabilities: row.capabilities as unknown as LocationCapabilities,
  };
}

/** `Location.charges`; shape in docs/architecture/database-design.md. */
export interface LocationCharges {
  currency: string;
  categories: {
    category: AircraftCategory;
    landingMinor: number;
    parkingMinor: number;
    handlingMinor: number;
  }[];
}

/** A whole location, for operations. */
export type AdminLocation = Omit<Location, 'capabilities' | 'charges'> & {
  capabilities: LocationCapabilities;
  charges: LocationCharges | null;
};

/** What operations may set. Everything else is managed by the system. */
export type LocationInput = Pick<
  AdminLocation,
  | 'type'
  | 'name'
  | 'iata'
  | 'icao'
  | 'city'
  | 'state'
  | 'country'
  | 'latitude'
  | 'longitude'
  | 'timeZone'
  | 'capabilities'
  | 'charges'
  | 'isActive'
>;

function toAdmin(location: Location): AdminLocation {
  return {
    ...location,
    capabilities: location.capabilities as unknown as LocationCapabilities,
    charges: location.charges as unknown as LocationCharges | null,
  };
}

/** Prisma needs `Prisma.DbNull` to store SQL NULL in a nullable JSON column. */
function toData(
  input: Partial<LocationInput>,
): Prisma.LocationUncheckedUpdateInput {
  const { capabilities, charges, ...rest } = input;
  return {
    ...rest,
    ...(capabilities !== undefined
      ? { capabilities: capabilities as unknown as Prisma.InputJsonObject }
      : {}),
    ...(charges !== undefined
      ? {
          charges:
            charges === null
              ? Prisma.DbNull
              : (charges as unknown as Prisma.InputJsonObject),
        }
      : {}),
  };
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Location not found.',
    HttpStatus.NOT_FOUND,
  );
}

function codeInUse(details: ErrorDetail[]): AppException {
  return new AppException(
    'LOCATION_CODE_IN_USE',
    'Another location already has this code.',
    HttpStatus.CONFLICT,
    details,
  );
}

/** Owns the Location table. Other modules read locations through it. */
@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Active locations matching a name, city or code. An exact IATA or ICAO
   * code ranks first, then names and cities that start with the term, then
   * any other match; airports before heliports, then by name.
   */
  async search(filter: {
    page: number;
    pageSize: number;
    q?: string;
    type?: LocationType;
  }): Promise<Paginated<PublicLocation>> {
    const term = normaliseSearchTerm(filter.q);
    const conditions: Prisma.Sql[] = [Prisma.sql`"isActive"`];
    if (filter.type) {
      conditions.push(Prisma.sql`"type" = ${filter.type}::"LocationType"`);
    }
    const order: Prisma.Sql[] = [
      Prisma.sql`("type" <> 'AIRPORT')`,
      Prisma.sql`"name"`,
      Prisma.sql`"id"`,
    ];
    if (term) {
      const code = term.toUpperCase();
      const prefix = `${escapeLike(term)}%`;
      const contains = `%${escapeLike(term)}%`;
      const matches = [
        Prisma.sql`"iata" = ${code}`,
        Prisma.sql`"name" ILIKE ${contains}`,
        Prisma.sql`"city" ILIKE ${contains}`,
      ];
      if (looksLikeCode(term)) {
        matches.push(Prisma.sql`"icao" LIKE ${`${code}%`}`);
      }
      conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
      order.unshift(Prisma.sql`CASE
        WHEN "iata" = ${code} OR "icao" = ${code} THEN 0
        WHEN "name" ILIKE ${prefix} THEN 1
        WHEN "city" ILIKE ${prefix} THEN 2
        ELSE 3 END`);
    }
    const where = Prisma.join(conditions, ' AND ');

    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<PublicRow[]>`
        SELECT ${PUBLIC_COLUMNS} FROM "Location" WHERE ${where}
        ORDER BY ${Prisma.join(order)}
        LIMIT ${filter.pageSize} OFFSET ${(filter.page - 1) * filter.pageSize}`,
      this.prisma.$queryRaw<[{ total: number }]>`
        SELECT COUNT(*)::int AS total FROM "Location" WHERE ${where}`,
    ]);
    return new Paginated(
      rows.map(toPublic),
      filter.page,
      filter.pageSize,
      total,
    );
  }

  /** An active location, for public use. */
  async getActive(id: string): Promise<PublicLocation> {
    const row = await this.prisma.location.findFirst({
      where: { id, isActive: true },
      select: PUBLIC_SELECT,
    });
    if (!row) throw notFound();
    return toPublic(row);
  }

  // --- Administration -----------------------------------------------------

  /** Every location, active or not, by name. */
  async adminList(filter: {
    page: number;
    pageSize: number;
    q?: string;
    type?: LocationType;
    isActive?: boolean;
  }): Promise<Paginated<AdminLocation>> {
    const term = normaliseSearchTerm(filter.q);
    const where: Prisma.LocationWhereInput = {
      type: filter.type,
      isActive: filter.isActive,
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { city: { contains: term, mode: 'insensitive' } },
              { iata: term.toUpperCase() },
              { icao: term.toUpperCase() },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.location.count({ where }),
    ]);
    return new Paginated(
      items.map(toAdmin),
      filter.page,
      filter.pageSize,
      total,
    );
  }

  async adminGet(id: string): Promise<AdminLocation> {
    const location = await this.prisma.location.findUnique({ where: { id } });
    if (!location) throw notFound();
    return toAdmin(location);
  }

  /** Adds a location. Audited as `location.create`. */
  async create(input: LocationInput): Promise<AdminLocation> {
    const created = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        await this.assertCodesFree(tx, input);
        const location = await tx.location.create({
          data: toData(input) as Prisma.LocationUncheckedCreateInput,
        });
        await this.audit.record(
          {
            action: 'location.create',
            entityType: 'Location',
            entityId: location.id,
            after: input as unknown as Prisma.InputJsonObject,
          },
          tx,
        );
        return location;
      }),
    );
    if (!created) throw codeInUse([]);
    return toAdmin(created);
  }

  /**
   * Changes the given fields. Audited as `location.update` with the fields
   * that changed, before and after; a request that changes nothing writes
   * nothing. Setting `isActive` to false hides the location from search.
   */
  async update(
    id: string,
    input: Partial<LocationInput>,
  ): Promise<AdminLocation> {
    const updated = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await tx.location.findUnique({ where: { id } });
        if (!current) throw notFound();
        const { before, after } = changedFields(toAdmin(current), input);
        if (Object.keys(after).length === 0) return current;

        await this.assertCodesFree(tx, after, id);
        const location = await tx.location.update({
          where: { id },
          data: toData(after),
        });
        await this.audit.record(
          {
            action: 'location.update',
            entityType: 'Location',
            entityId: id,
            before: before as unknown as Prisma.InputJsonObject,
            after: after as unknown as Prisma.InputJsonObject,
          },
          tx,
        );
        return location;
      }),
    );
    if (!updated) throw codeInUse([]);
    return toAdmin(updated);
  }

  /** Refuses an IATA or ICAO code another location already holds. */
  private async assertCodesFree(
    db: Prisma.TransactionClient,
    codes: { iata?: string | null; icao?: string | null },
    exceptId?: string,
  ): Promise<void> {
    const details: ErrorDetail[] = [];
    for (const field of ['iata', 'icao'] as const) {
      const code = codes[field];
      if (!code) continue;
      const holder = await db.location.findFirst({
        where: {
          [field]: code,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { id: true },
      });
      if (holder) details.push({ field, issue: 'is already in use' });
    }
    if (details.length > 0) throw codeInUse(details);
  }
}

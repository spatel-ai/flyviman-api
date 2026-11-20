import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  OperatorStatus,
  PricingRuleScope,
  PricingRuleType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { OperatorsService } from '../operators/operators.service.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import type {
  AdminAircraftPricingDto,
  AdminOperatorPricingDto,
  AircraftPricingDto,
  AircraftPricingResponseDto,
  FixedRouteDto,
  MinHoursPer,
  OperatorPricingDto,
  OperatorPricingResponseDto,
} from './dto/operator-pricing.dto.js';
import { planRuleChanges } from './rule-changes.js';
import type { RuleConfigs, RuleRow } from './rules.js';
import { lockRuleKey } from './rule-lock.js';

const OPERATOR_TYPES = [
  PricingRuleType.MIN_BILLABLE_HOURS,
  PricingRuleType.POSITIONING,
  PricingRuleType.LANDING,
  PricingRuleType.HANDLING,
  PricingRuleType.WAITING,
  PricingRuleType.OVERNIGHT,
  PricingRuleType.CREW,
  PricingRuleType.FUEL_SURCHARGE,
  PricingRuleType.PERMIT,
  PricingRuleType.NAVIGATION,
  PricingRuleType.OTHER,
] as const;

const AIRCRAFT_TYPES = [
  PricingRuleType.HOURLY_RATE,
  PricingRuleType.MIN_BILLABLE_HOURS,
  PricingRuleType.SECTOR_RATE,
  PricingRuleType.FIXED_ROUTE,
] as const;

/** Aircraft listed by the internal read; an operator's fleet is far smaller. */
const ADMIN_FLEET_LIMIT = 100;

const RULE_SELECT = {
  id: true,
  scope: true,
  scopeRef: true,
  type: true,
  config: true,
  priority: true,
  version: true,
} as const satisfies Prisma.PricingRuleSelect;

/**
 * Pricing inputs an operator administrator sets for their own organisation
 * and aircraft (M5 slice 2; pricing-engine.md, "Who edits what"). Only
 * operator-owned rule types: commission, markup, fees and tax are
 * Flyviman's and are never written here. Every change is a new rule version
 * with an audit record (business rule 6).
 */
@Injectable()
export class OperatorPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly audit: AuditService,
    private readonly aircraft: AircraftService,
  ) {}

  async getOperator(user: AuthUser): Promise<OperatorPricingResponseDto> {
    return this.operatorView(await this.operatorOf(user));
  }

  /**
   * The internal read (M10): an operator's defaults and every aircraft's
   * rate, read-only, for operations, finance and super administrators
   * (security-rbac.md, "Submit operator pricing inputs"). An unknown
   * operator is 404. At most `ADMIN_FLEET_LIMIT` aircraft, newest first.
   */
  async adminView(operatorId: string): Promise<AdminOperatorPricingDto> {
    const operator = await this.operators.getById(operatorId);
    const fleet = await this.aircraft.adminList({
      page: 1,
      pageSize: ADMIN_FLEET_LIMIT,
      operatorId,
    });
    const aircraft: AdminAircraftPricingDto[] = [];
    for (const row of fleet.items) {
      aircraft.push({
        ...(await this.aircraftView(row.id)),
        registration: row.registration,
        manufacturer: row.manufacturer,
        model: row.model,
        pricingModel: row.pricingModel,
      });
    }
    return {
      operatorId: operator.id,
      operatorName: operator.legalName,
      operator: await this.operatorView(operator.id),
      aircraft,
      aircraftTotal: fleet.total,
    };
  }

  private async operatorView(
    operatorId: string,
  ): Promise<OperatorPricingResponseDto> {
    return toOperatorDto(
      await this.inForce(PricingRuleScope.OPERATOR, operatorId, OPERATOR_TYPES),
    );
  }

  async setOperator(
    user: AuthUser,
    dto: OperatorPricingDto,
  ): Promise<OperatorPricingResponseDto> {
    const operatorId = await this.approvedOperatorOf(user);
    const desired = new Map<string, unknown>([
      [
        PricingRuleType.POSITIONING,
        dto.positioningRateFactor == null
          ? null
          : {
              rateFactor: dto.positioningRateFactor,
              freeWithinKm: dto.freeWithinKm ?? 0,
            },
      ],
      [
        PricingRuleType.LANDING,
        dto.landingFallbackMinor == null
          ? null
          : { amountMinor: dto.landingFallbackMinor },
      ],
      [
        PricingRuleType.HANDLING,
        dto.handlingFallbackMinor == null
          ? null
          : { amountMinor: dto.handlingFallbackMinor },
      ],
    ]);
    // Optional charges: left out keeps what is in force; null clears.
    const amounts = [
      [PricingRuleType.OVERNIGHT, dto.overnightMinor],
      [PricingRuleType.CREW, dto.crewNightMinor],
      [PricingRuleType.FUEL_SURCHARGE, dto.fuelSurchargePerFlightMinor],
      [PricingRuleType.PERMIT, dto.permitPerFlightMinor],
      [PricingRuleType.NAVIGATION, dto.navigationPerFlightMinor],
    ] as const;
    for (const [type, amountMinor] of amounts) {
      if (amountMinor !== undefined) {
        desired.set(type, amountMinor == null ? null : { amountMinor });
      }
    }
    await this.save(
      user,
      PricingRuleScope.OPERATOR,
      operatorId,
      OPERATOR_TYPES,
      (current) => {
        // Read under the lock, so a field left out keeps the value in force
        // even when another save lands first.
        desired.set(
          PricingRuleType.MIN_BILLABLE_HOURS,
          minHoursConfig(
            dto.minBillableHours,
            dto.minBillableHoursPer,
            storedConfig(current, 'MIN_BILLABLE_HOURS'),
          ),
        );
        const waiting = waitingConfig(dto, storedConfig(current, 'WAITING'));
        if (waiting !== undefined)
          desired.set(PricingRuleType.WAITING, waiting);
        const other = otherConfig(dto, storedConfig(current, 'OTHER'));
        if (other !== undefined) desired.set(PricingRuleType.OTHER, other);
        return desired;
      },
    );
    return this.getOperator(user);
  }

  async getAircraft(
    user: AuthUser,
    aircraftId: string,
  ): Promise<AircraftPricingResponseDto> {
    await this.ownAircraft(user, aircraftId);
    return this.aircraftView(aircraftId);
  }

  private async aircraftView(
    aircraftId: string,
  ): Promise<AircraftPricingResponseDto> {
    const rules = await this.inForce(
      PricingRuleScope.AIRCRAFT,
      aircraftId,
      AIRCRAFT_TYPES,
    );
    const routes = configOf(rules, 'FIXED_ROUTE')?.routes ?? [];
    const names = new Map(
      (
        await this.prisma.location.findMany({
          where: {
            id: {
              in: routes.flatMap((route) => [
                route.originId,
                route.destinationId,
              ]),
            },
          },
          select: { id: true, name: true },
        })
      ).map((location) => [location.id, location.name]),
    );
    return toAircraftDto(aircraftId, rules, names);
  }

  async setAircraft(
    user: AuthUser,
    aircraftId: string,
    dto: AircraftPricingDto,
  ): Promise<AircraftPricingResponseDto> {
    await this.approvedOperatorOf(user);
    await this.ownAircraft(user, aircraftId);
    if (dto.fixedRoutes) await this.checkFixedRoutes(dto.fixedRoutes);
    const flags = {
      taxInclusive: dto.taxInclusive,
      commissionInclusive: dto.commissionInclusive,
    };
    await this.save(
      user,
      PricingRuleScope.AIRCRAFT,
      aircraftId,
      AIRCRAFT_TYPES,
      (current) => {
        // The flags belong to all the aircraft's rates: a rate left out is
        // kept, under the flags sent.
        const desired = new Map<string, unknown>([
          [
            PricingRuleType.HOURLY_RATE,
            dto.hourlyRateMinor == null
              ? null
              : {
                  amountMinor: dto.hourlyRateMinor,
                  currency: 'INR',
                  ...flags,
                },
          ],
          [
            PricingRuleType.MIN_BILLABLE_HOURS,
            minHoursConfig(
              dto.minBillableHours,
              dto.minBillableHoursPer,
              storedConfig(current, 'MIN_BILLABLE_HOURS'),
            ),
          ],
        ]);
        const sector =
          dto.sectorRateMinor === undefined
            ? storedConfig(current, 'SECTOR_RATE')?.amountMinor
            : dto.sectorRateMinor;
        if (sector !== undefined) {
          desired.set(
            PricingRuleType.SECTOR_RATE,
            sector === null
              ? null
              : { amountMinor: sector, currency: 'INR', ...flags },
          );
        }
        const routes =
          dto.fixedRoutes === undefined
            ? storedConfig(current, 'FIXED_ROUTE')?.routes
            : dto.fixedRoutes;
        if (routes !== undefined) {
          desired.set(
            PricingRuleType.FIXED_ROUTE,
            routes === null || routes.length === 0
              ? null
              : {
                  currency: 'INR',
                  ...flags,
                  routes: routes.map(
                    ({ originId, destinationId, amountMinor }) => ({
                      originId,
                      destinationId,
                      amountMinor,
                    }),
                  ),
                },
          );
        }
        return desired;
      },
    );
    return this.getAircraft(user, aircraftId);
  }

  // --- Internals ----------------------------------------------------------

  /** Each route between two different active locations, listed once. */
  private async checkFixedRoutes(routes: FixedRouteDto[]): Promise<void> {
    const ids = [
      ...new Set(routes.flatMap((r) => [r.originId, r.destinationId])),
    ];
    const active = new Set(
      (
        await this.prisma.location.findMany({
          where: { id: { in: ids }, isActive: true },
          select: { id: true },
        })
      ).map((location) => location.id),
    );
    const problems = fixedRouteProblems(routes, active);
    if (problems.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The fixed routes are not valid.',
        HttpStatus.BAD_REQUEST,
        problems,
      );
    }
  }

  private async operatorOf(user: AuthUser): Promise<string> {
    const { operator } = await this.operators.accessFor(user);
    return operator.id;
  }

  /**
   * Changing rates needs an approved operator (security-rbac.md); reading
   * stays open, so a suspended operator still sees what it had set.
   */
  private async approvedOperatorOf(user: AuthUser): Promise<string> {
    const { operator } = await this.operators.accessFor(user);
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can change pricing.',
        HttpStatus.CONFLICT,
      );
    }
    return operator.id;
  }

  /** The aircraft must be the caller's operator's; otherwise it is not found. */
  private async ownAircraft(user: AuthUser, aircraftId: string): Promise<void> {
    const operatorId = await this.operatorOf(user);
    const unknown = await this.operators.unknownAircraft(operatorId, [
      aircraftId,
    ]);
    if (unknown.length > 0) {
      throw new AppException(
        'NOT_FOUND',
        'Aircraft not found.',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async inForce(
    scope: PricingRuleScope,
    scopeRef: string,
    types: readonly PricingRuleType[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Map<string, RuleRow>> {
    const now = new Date();
    const rows = await db.pricingRule.findMany({
      where: {
        scope,
        scopeRef,
        type: { in: [...types] },
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      orderBy: { version: 'desc' },
      select: RULE_SELECT,
    });
    const byType = new Map<string, RuleRow>();
    for (const row of rows)
      if (!byType.has(row.type)) byType.set(row.type, row);
    return byType;
  }

  private async save(
    user: AuthUser,
    scope: PricingRuleScope,
    scopeRef: string,
    types: readonly PricingRuleType[],
    /** The settings wanted, given what is in force under the locks. */
    plan: (current: Map<string, RuleRow>) => Map<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // One lock per rule key, in a fixed order so two saves never wait on
      // each other in a cycle; the in-force read then sees any save that
      // finished first (security review M2).
      for (const type of [...types].sort()) {
        await lockRuleKey(tx, type, scope, scopeRef);
      }
      const now = new Date();
      const current = await this.inForce(scope, scopeRef, types, tx);
      for (const change of planRuleChanges(current, plan(current))) {
        if (change.close) {
          await tx.pricingRule.update({
            where: { id: change.close.id },
            data: { isActive: false, validTo: now },
          });
        }
        const created = change.create
          ? await tx.pricingRule.create({
              data: {
                scope,
                scopeRef,
                type: change.type as PricingRuleType,
                config: change.create.config as Prisma.InputJsonValue,
                version: change.create.version,
                validFrom: now,
                createdById: user.id,
              },
              select: { id: true },
            })
          : null;
        await this.audit.record(
          {
            action: 'pricing_rule.change',
            entityType: 'PricingRule',
            entityId: created?.id ?? change.close!.id,
            before: change.close
              ? ({
                  type: change.type,
                  scope,
                  scopeRef,
                  version: change.close.version,
                  config: change.close.config,
                } as Prisma.InputJsonValue)
              : undefined,
            after: change.create
              ? ({
                  type: change.type,
                  scope,
                  scopeRef,
                  version: change.create.version,
                  config: change.create.config,
                } as Prisma.InputJsonValue)
              : undefined,
          },
          tx,
        );
      }
    });
  }
}

/**
 * The waiting rule wanted: undefined to leave it, null to clear it. Each of
 * `waitingHourlyMinor` and `waitingFreeHours` left out keeps its stored
 * value; `waitingHourlyMinor: null` clears the rule; `waitingFreeHours:
 * null` is 0. Free hours without a rate on record or sent set nothing.
 */
export function waitingConfig(
  dto: Pick<OperatorPricingDto, 'waitingHourlyMinor' | 'waitingFreeHours'>,
  stored: RuleConfigs['WAITING'] | undefined,
): RuleConfigs['WAITING'] | null | undefined {
  if (dto.waitingHourlyMinor === null) return null;
  if (
    dto.waitingHourlyMinor === undefined &&
    dto.waitingFreeHours === undefined
  ) {
    return undefined;
  }
  const amountMinor = dto.waitingHourlyMinor ?? stored?.amountMinor;
  if (amountMinor === undefined) return undefined;
  const freeHours =
    dto.waitingFreeHours === undefined
      ? (stored?.freeHours ?? 0)
      : (dto.waitingFreeHours ?? 0);
  return { amountMinor, freeHours };
}

/**
 * The minimum billable hours wanted: null clears; `per` left out keeps the
 * stored one; `LEG` (or null) is stored as no `per`, so a rule saved
 * unchanged stays equal and writes nothing.
 */
export function minHoursConfig(
  hours: number | null,
  per: MinHoursPer | null | undefined,
  stored: RuleConfigs['MIN_BILLABLE_HOURS'] | undefined,
): RuleConfigs['MIN_BILLABLE_HOURS'] | null {
  if (hours == null) return null;
  const wanted = per === undefined ? stored?.per : per;
  return wanted === 'DAY' ? { hours, per: 'DAY' } : { hours };
}

/**
 * The other charge wanted: undefined to leave it, null to clear it. Each of
 * `otherChargeMinor` and `otherChargeLabel` left out keeps its stored
 * value; a new charge needs a label. A label alone, with no charge on
 * record, sets nothing.
 */
export function otherConfig(
  dto: Pick<OperatorPricingDto, 'otherChargeMinor' | 'otherChargeLabel'>,
  stored: RuleConfigs['OTHER'] | undefined,
): RuleConfigs['OTHER'] | null | undefined {
  if (dto.otherChargeMinor === null) return null;
  if (
    dto.otherChargeMinor === undefined &&
    dto.otherChargeLabel === undefined
  ) {
    return undefined;
  }
  const amountMinor = dto.otherChargeMinor ?? stored?.amountMinor;
  if (amountMinor === undefined) return undefined;
  const label = dto.otherChargeLabel ?? stored?.label;
  if (label === undefined) {
    throw new AppException(
      'VALIDATION_ERROR',
      'The other charge needs a name.',
      HttpStatus.BAD_REQUEST,
      [
        {
          field: 'otherChargeLabel',
          issue: 'is required with otherChargeMinor',
        },
      ],
    );
  }
  return { label, amountMinor };
}

/** Problems with a list of fixed routes, given the active location ids. */
export function fixedRouteProblems(
  routes: FixedRouteDto[],
  active: ReadonlySet<string>,
): { field: string; issue: string }[] {
  const problems: { field: string; issue: string }[] = [];
  const seen = new Set<string>();
  routes.forEach((route, index) => {
    const at = `fixedRoutes[${index}]`;
    for (const key of ['originId', 'destinationId'] as const) {
      if (!active.has(route[key])) {
        problems.push({
          field: `${at}.${key}`,
          issue: 'must be an active location',
        });
      }
    }
    if (route.originId === route.destinationId) {
      problems.push({
        field: `${at}.destinationId`,
        issue: 'must differ from the origin',
      });
    }
    const pair = [route.originId, route.destinationId].sort().join(':');
    if (seen.has(pair)) {
      problems.push({
        field: at,
        issue: 'lists a route already listed (either direction)',
      });
    }
    seen.add(pair);
  });
  return problems;
}

function storedConfig<K extends keyof RuleConfigs>(
  rules: Map<string, RuleRow>,
  type: K,
): RuleConfigs[K] | undefined {
  return rules.get(type)?.config as RuleConfigs[K] | undefined;
}

function configOf<K extends keyof RuleConfigs>(
  rules: Map<string, RuleRow>,
  type: K,
): RuleConfigs[K] | null {
  return (rules.get(type)?.config as RuleConfigs[K] | undefined) ?? null;
}

function toOperatorDto(
  rules: Map<string, RuleRow>,
): OperatorPricingResponseDto {
  const positioning = configOf(rules, 'POSITIONING');
  const waiting = configOf(rules, 'WAITING');
  const minimum = configOf(rules, 'MIN_BILLABLE_HOURS');
  const other = configOf(rules, 'OTHER');
  return {
    currency: 'INR',
    minBillableHours: minimum?.hours ?? null,
    positioningRateFactor: positioning?.rateFactor ?? null,
    freeWithinKm: positioning ? (positioning.freeWithinKm ?? 0) : null,
    landingFallbackMinor: configOf(rules, 'LANDING')?.amountMinor ?? null,
    handlingFallbackMinor: configOf(rules, 'HANDLING')?.amountMinor ?? null,
    waitingHourlyMinor: waiting?.amountMinor ?? null,
    waitingFreeHours: waiting?.freeHours ?? null,
    overnightMinor: configOf(rules, 'OVERNIGHT')?.amountMinor ?? null,
    crewNightMinor: configOf(rules, 'CREW')?.amountMinor ?? null,
    minBillableHoursPer: minimum ? (minimum.per ?? 'LEG') : null,
    fuelSurchargePerFlightMinor:
      configOf(rules, 'FUEL_SURCHARGE')?.amountMinor ?? null,
    permitPerFlightMinor: configOf(rules, 'PERMIT')?.amountMinor ?? null,
    navigationPerFlightMinor:
      configOf(rules, 'NAVIGATION')?.amountMinor ?? null,
    otherChargeMinor: other?.amountMinor ?? null,
    otherChargeLabel: other?.label ?? null,
  };
}

function toAircraftDto(
  aircraftId: string,
  rules: Map<string, RuleRow>,
  names: Map<string, string>,
): AircraftPricingResponseDto {
  const rate = configOf(rules, 'HOURLY_RATE');
  const sector = configOf(rules, 'SECTOR_RATE');
  const fixed = configOf(rules, 'FIXED_ROUTE');
  const minimum = configOf(rules, 'MIN_BILLABLE_HOURS');
  // Saved together, so any rate in force carries the aircraft's flags.
  const flags = rate ?? sector ?? fixed;
  return {
    aircraftId,
    currency: 'INR',
    hourlyRateMinor: rate?.amountMinor ?? null,
    taxInclusive: flags?.taxInclusive ?? false,
    commissionInclusive: flags?.commissionInclusive ?? false,
    minBillableHours: minimum?.hours ?? null,
    minBillableHoursPer: minimum ? (minimum.per ?? 'LEG') : null,
    sectorRateMinor: sector?.amountMinor ?? null,
    fixedRoutes: (fixed?.routes ?? []).map((route) => ({
      ...route,
      originName: names.get(route.originId) ?? '',
      destinationName: names.get(route.destinationId) ?? '',
    })),
  };
}

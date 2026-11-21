import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  ReconciliationQueryDto,
  ReconciliationReportDto,
} from './dto/reconciliation.dto.js';
import {
  AdminSettlementDto,
  AdminSettlementsQueryDto,
  UpdateSettlementDto,
} from './dto/settlement.dto.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SettlementsService } from './settlements.service.js';

/**
 * Operator settlements and reconciliation for finance (M9, W4-2): finance
 * and the super administrator only. Payouts are made by hand
 * (`SETTLEMENT_MODE=manual`) and recorded here.
 */
@ApiTags('admin-payments')
@ApiCookieAuth()
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin')
export class AdminSettlementsController {
  constructor(
    private readonly settlements: SettlementsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('settlements')
  @ApiOperation({
    summary: 'Operator settlements, newest first',
    description:
      'One per completed booking with money kept, created by a job every 5 minutes: `payableMinor` = money kept − `commissionMinor` − `taxMinor`, from the price calculation of the price booked. `DUE` once the booking is `COMPLETED` and its price was paid in full, no refund is on its way and the figures add up to the money kept; otherwise `NOT_DUE`, with `notDueReason`. A refund after the trip comes out of the payable; one larger than the payable leaves it `NOT_DUE` (“Refund exceeds payable — finance to resolve.”). Filter by `status`.',
  })
  @ApiOkResponse({ type: [AdminSettlementDto] })
  async list(
    @Query() query: AdminSettlementsQueryDto,
  ): Promise<Paginated<AdminSettlementDto>> {
    const { items, total } = await this.settlements.adminList(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @Patch('settlements/:id')
  @Idempotent()
  @ApiOperation({
    summary: 'Hold, release or mark a settlement paid',
    description:
      '`ON_HOLD` from `NOT_DUE` or `DUE`; `DUE` from `ON_HOLD` releases the hold: the record becomes what the rules give now (`DUE` or `NOT_DUE`, see `notDueReason`); `PAID` from `DUE` with the payout’s bank `paymentReference` and the `expectedPayableMinor` shown, only while still due (409 `SETTLEMENT_NOT_DUE`, the reason in `details`; a `NOT_DUE` record answers the same) and unchanged (409 `SETTLEMENT_CHANGED`, the current payable in `details`). A `PAID` record never changes again: marking it paid with the same reference returns it, another reference is 409 `SETTLEMENT_ALREADY_PAID`; a reference already on another operator’s settlement (ignoring case) is 409 `SETTLEMENT_REFERENCE_USED` (one transfer may pay several of the same operator’s settlements); any other move is 409 `SETTLEMENT_INVALID_TRANSITION`. Audited with the reason. A repeat with the same `Idempotency-Key` and body returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each change and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: AdminSettlementDto })
  change(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSettlementDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<AdminSettlementDto> {
    return this.settlements.change(id, body, claim);
  }

  @Get('reconciliation')
  @ApiOperation({
    summary: 'Reconciliation report for a period',
    description:
      'Per currency: payments whose money arrived (by `paidAt`), refunds started (by `createdAt`, completed and still open), bookings with a payment created in the period and the money kept on them now, settlements created (by `createdAt`) and paid out (by `paidAt`). Then the mismatches, checked as they are now, on every booking with a payment, refund or settlement in the period or completed in it. Reads Flyviman’s own record only; it does not ask the gateway. The period is at most 92 days (400 `VALIDATION_ERROR`).',
  })
  @ApiOkResponse({ type: ReconciliationReportDto })
  report(
    @Query() query: ReconciliationQueryDto,
  ): Promise<ReconciliationReportDto> {
    return this.reconciliation.report(query);
  }
}

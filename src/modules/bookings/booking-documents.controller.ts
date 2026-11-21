import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { BookingDocumentsService } from './booking-documents.service.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import { BookingDocumentDto } from './dto/booking-documents.dto.js';

/** A customer's booking documents (M8-C). */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('bookings')
export class BookingDocumentsController {
  constructor(private readonly documents: BookingDocumentsService) {}

  @Get(':reference/documents')
  @ApiOperation({
    summary: 'The documents of one of the caller’s bookings',
    description:
      'Worked out from the booking, nothing stored: the confirmation (available once `CONFIRMED`, `SCHEDULED` or `COMPLETED`), a receipt for each payment whose money arrived, and the cancellation terms accepted with the request. Another customer’s booking is 404.',
  })
  @ApiOkResponse({ type: [BookingDocumentDto] })
  list(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<BookingDocumentDto[]> {
    return this.documents.forCustomer(user, reference);
  }
}

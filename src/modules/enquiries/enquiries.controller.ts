import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor.js';
import { EnquiryRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Public } from '../auth/auth.decorators.js';
import { CreateEnquiryDto, EnquiryResponseDto } from './dto/enquiry.dto.js';
import { EnquiriesService } from './enquiries.service.js';

@ApiTags('enquiries')
@Controller('enquiries')
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Post()
  @Public()
  @Idempotent()
  @EnquiryRateLimit()
  @ApiOperation({
    summary: 'Send a sales enquiry from the contact page',
    description:
      'Charter, aircraft sales or consultancy. Needs an email address or a phone number, or both. Operations are emailed; the answer is a reference and never repeats what was sent. Limited per caller (5 per 10 minutes by default; 429 `RATE_LIMITED`). A repeat with the same `Idempotency-Key` and body returns the first answer; with a different body, 409 `IDEMPOTENCY_CONFLICT`.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each enquiry and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({ type: EnquiryResponseDto })
  create(@Body() body: CreateEnquiryDto): Promise<EnquiryResponseDto> {
    return this.enquiries.create(body);
  }
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';

const SCOPE =
  'Non-mandatory messages only: mandatory messages (security codes, urgent air ambulance updates and the like) are always sent, and in-app and email are never turned off.';

export class NotificationPreferencesResponseDto {
  @ApiProperty({ description: `No SMS messages. ${SCOPE}` })
  smsOptedOut: boolean;

  @ApiProperty({ description: `No WhatsApp messages. ${SCOPE}` })
  whatsappOptedOut: boolean;
}

/** Fields left out keep their value; `null` is refused. */
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ description: `No SMS messages. ${SCOPE}` })
  @OptionalNotNull()
  @IsBoolean()
  smsOptedOut?: boolean;

  @ApiPropertyOptional({ description: `No WhatsApp messages. ${SCOPE}` })
  @OptionalNotNull()
  @IsBoolean()
  whatsappOptedOut?: boolean;
}

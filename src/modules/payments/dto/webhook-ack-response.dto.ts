import { ApiProperty } from '@nestjs/swagger';

export class WebhookAckResponseDto {
  @ApiProperty({ example: true })
  received: true;
}

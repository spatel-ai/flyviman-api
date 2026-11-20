import { ApiProperty } from '@nestjs/swagger';

export class NotificationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'operator.approved' })
  templateKey: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/account/trips/FV-ABC123',
    description:
      "The site path the message is about (a booking, an air ambulance request), for the reader's own portal; null when there is none.",
  })
  href: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

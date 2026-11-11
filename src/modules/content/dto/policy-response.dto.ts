import { ApiProperty } from '@nestjs/swagger';

export class PolicyResponseDto {
  @ApiProperty({ example: 'terms' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({
    description: 'Plain text with blank lines between paragraphs.',
  })
  body: string;

  @ApiProperty({ example: '2026-11-01' })
  version: string;

  @ApiProperty({ format: 'date-time' })
  publishedAt: string;
}

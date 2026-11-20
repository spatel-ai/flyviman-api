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

export class PublicContentItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'A banner headline, or the question of a FAQ.' })
  title: string;

  @ApiProperty({
    description: 'Plain text, never HTML. A banner message, or the answer.',
  })
  body: string;
}

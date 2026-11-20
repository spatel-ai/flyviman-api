import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The response envelope, described once in the OpenAPI document as shared
 * schemas (`extraModels` in `createOpenApiDocument`). Each route's schema is
 * its `data` payload; the web client unwraps the envelope itself.
 */
export class ResponseMetaDto {
  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;

  @ApiPropertyOptional({ description: 'List routes only.', example: 1 })
  page?: number;

  @ApiPropertyOptional({ description: 'List routes only.', example: 20 })
  pageSize?: number;

  @ApiPropertyOptional({ description: 'List routes only.', example: 134 })
  total?: number;
}

export class EnvelopeDto {
  @ApiProperty({
    description:
      "The route's documented response: an object, or an array on list routes. `null` when the route returns nothing.",
    nullable: true,
    oneOf: [{ type: 'object' }, { type: 'array', items: {} }],
  })
  data: unknown;

  @ApiProperty({ type: ResponseMetaDto })
  meta: ResponseMetaDto;
}

export class ErrorDetailDto {
  @ApiPropertyOptional({ example: 'totalMinor' })
  field?: string;

  @ApiProperty()
  issue: string;
}

export class ErrorBodyDto {
  @ApiProperty({
    description:
      'Stable upper snake case code; clients switch on it, never on `message`.',
    example: 'VALIDATION_ERROR',
  })
  code: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ type: [ErrorDetailDto] })
  details: ErrorDetailDto[];

  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;
}

export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorBodyDto })
  error: ErrorBodyDto;
}

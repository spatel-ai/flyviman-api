import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { OptionalNotNull } from './optional.js';
import { PageQueryDto } from './page-query.dto.js';

export const LIST_SORTS = [
  'created_desc',
  'departure_asc',
  'departure_desc',
] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/**
 * The `sort` query parameter. The value only selects one of a fixed set of
 * orders in the service; it is never put into a query.
 */
export const SortField = () =>
  applyDecorators(
    ApiPropertyOptional({
      enum: LIST_SORTS,
      default: 'created_desc',
      description:
        '`created_desc`: newest first (the default). `departure_asc` / `departure_desc`: by the first departure, soonest or latest first, across all pages; rows with no departure time come last. Ties are broken by id, so paging is stable.',
    }),
    OptionalNotNull(),
    IsIn(LIST_SORTS),
  );

/** A page query that can also choose the order. */
export class SortedPageQueryDto extends PageQueryDto {
  @SortField()
  sort: ListSort = 'created_desc';
}

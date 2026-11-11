/**
 * Return this from a controller for list endpoints. The response envelope
 * interceptor moves `page`, `pageSize` and `total` into `meta`.
 */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly page: number,
    readonly pageSize: number,
    readonly total: number,
  ) {}
}

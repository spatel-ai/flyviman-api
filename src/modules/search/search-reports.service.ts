import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ServiceCategory } from '../../generated/prisma/enums.js';

/** Searches per category in a period, for the reports module (W5-1). */
export interface SearchCategoryFigures {
  category: ServiceCategory;
  searches: number;
  withoutResults: number;
  averageResults: number | null;
  averageDurationMs: number | null;
}

/**
 * Read-only aggregates over the search log (`Search`) for the reports
 * module, which may not read this module's table itself.
 */
@Injectable()
export class SearchReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async byCategory(
    createdAt: { gte: Date; lt: Date },
    category?: ServiceCategory,
  ): Promise<SearchCategoryFigures[]> {
    const where = { createdAt, ...(category ? { category } : {}) };
    const [all, empty] = await Promise.all([
      this.prisma.search.groupBy({
        by: ['category'],
        where,
        _count: { _all: true },
        _avg: { resultCount: true, durationMs: true },
      }),
      this.prisma.search.groupBy({
        by: ['category'],
        where: { ...where, resultCount: 0 },
        _count: { _all: true },
      }),
    ]);
    return all.map((row) => ({
      category: row.category,
      searches: row._count._all,
      withoutResults:
        empty.find((e) => e.category === row.category)?._count._all ?? 0,
      averageResults: row._avg.resultCount,
      averageDurationMs: row._avg.durationMs,
    }));
  }

  count(createdAt: { gte: Date; lt: Date }): Promise<number> {
    return this.prisma.search.count({ where: { createdAt } });
  }
}

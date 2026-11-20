import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ContentKind } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface Policy {
  slug: string;
  title: string;
  body: string;
  version: string;
  publishedAt: Date;
}

export interface PublicItem {
  id: string;
  title: string;
  body: string;
}

/** Most items a public list returns, so the answer stays small. */
const PUBLIC_LIMIT = 50;

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  /** A published policy, or `null`. */
  async findPolicy(slug: string): Promise<Policy | null> {
    const item = await this.prisma.contentItem.findUnique({
      where: { kind_slug: { kind: ContentKind.POLICY, slug } },
    });
    if (!item?.publishedAt || item.publishedAt > new Date() || !item.version) {
      return null;
    }
    return {
      slug: item.slug,
      title: item.title,
      body: item.body,
      version: item.version,
      publishedAt: item.publishedAt,
    };
  }

  async getPolicy(slug: string): Promise<Policy> {
    const policy = await this.findPolicy(slug);
    if (!policy) {
      throw new AppException(
        'NOT_FOUND',
        'Policy not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return policy;
  }

  /** Published banners or questions, in display order, never drafts. */
  async listPublished(kind: 'BANNER' | 'FAQ'): Promise<PublicItem[]> {
    const items = await this.prisma.contentItem.findMany({
      where: { kind, publishedAt: { not: null, lte: new Date() } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: PUBLIC_LIMIT,
      select: { id: true, title: true, body: true },
    });
    return items;
  }
}

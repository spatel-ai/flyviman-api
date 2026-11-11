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
}

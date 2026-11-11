import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * A short-lived Prisma client for e2e setup that the HTTP API cannot do yet
 * (for example forcing an aircraft to APPROVED before admin review ships).
 */
export async function withPrisma<T>(
  run: (prisma: PrismaClient) => Promise<T>,
): Promise<T> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    }),
  });
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

import type { PromotionInput } from './engine.js';

/**
 * Promotion codes (M10): whether a code applies to a trip and a customer.
 * Pure, so every refusal is unit tested; `PromotionsService` reads the row
 * and the usage counts and calls these.
 */

/** Codes are kept and compared upper case, without surrounding spaces. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Letters, digits and dashes, 3 to 32 characters (after `normalizeCode`). */
export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$/;

export interface PromotionTerms {
  id: string;
  code: string;
  name: string;
  kind: 'PERCENT' | 'FIXED';
  percentBasisPoints: number | null;
  amountMinor: number | null;
  category: string | null;
  originId: string | null;
  destinationId: string | null;
  startsAt: Date;
  endsAt: Date;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
  endedAt: Date | null;
}

export interface PromotionTrip {
  now: Date;
  category: string;
  originId: string;
  destinationId: string;
}

/** Uses so far: overall, and the customer's own (null: not signed in). */
export interface PromotionUsage {
  total: number;
  customer: number | null;
}

export type PromotionProblem =
  | 'PROMO_CODE_INVALID'
  | 'PROMO_CODE_EXPIRED'
  | 'PROMO_CODE_NOT_APPLICABLE'
  | 'PROMO_CODE_LIMIT_REACHED';

/**
 * Why `promotion` cannot be used on `trip`, or null when it can. A code not
 * yet started reads as invalid, so a scheduled promotion is not revealed
 * early. The route matches in either direction.
 */
export function promotionProblem(
  promotion: PromotionTerms | null,
  trip: PromotionTrip,
  usage: PromotionUsage,
): PromotionProblem | null {
  if (!promotion) return 'PROMO_CODE_INVALID';
  const now = trip.now.getTime();
  if (now < promotion.startsAt.getTime()) return 'PROMO_CODE_INVALID';
  if (promotion.endedAt || now >= promotion.endsAt.getTime()) {
    return 'PROMO_CODE_EXPIRED';
  }
  if (promotion.category && promotion.category !== trip.category) {
    return 'PROMO_CODE_NOT_APPLICABLE';
  }
  if (promotion.originId && promotion.destinationId) {
    const ends = [promotion.originId, promotion.destinationId];
    const onRoute =
      ends.includes(trip.originId) &&
      ends.includes(trip.destinationId) &&
      trip.originId !== trip.destinationId;
    if (!onRoute) return 'PROMO_CODE_NOT_APPLICABLE';
  }
  if (promotion.maxUses != null && usage.total >= promotion.maxUses) {
    return 'PROMO_CODE_LIMIT_REACHED';
  }
  if (
    promotion.maxUsesPerCustomer != null &&
    usage.customer != null &&
    usage.customer >= promotion.maxUsesPerCustomer
  ) {
    return 'PROMO_CODE_LIMIT_REACHED';
  }
  return null;
}

/** The promotion as the engine applies it. */
export function engineInput(promotion: PromotionTerms): PromotionInput {
  return promotion.kind === 'PERCENT'
    ? {
        id: promotion.id,
        code: promotion.code,
        name: promotion.name,
        kind: 'PERCENT',
        percent: (promotion.percentBasisPoints ?? 0) / 100,
      }
    : {
        id: promotion.id,
        code: promotion.code,
        name: promotion.name,
        kind: 'FIXED',
        amountMinor: promotion.amountMinor ?? 0,
      };
}

export type PromotionStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED';

export function promotionStatus(
  promotion: Pick<PromotionTerms, 'startsAt' | 'endsAt' | 'endedAt'>,
  now: Date,
): PromotionStatus {
  if (promotion.endedAt || now.getTime() >= promotion.endsAt.getTime()) {
    return 'ENDED';
  }
  return now.getTime() < promotion.startsAt.getTime() ? 'SCHEDULED' : 'ACTIVE';
}

export const PROMOTION_MESSAGES: Record<PromotionProblem, string> = {
  PROMO_CODE_INVALID: 'This code is not valid.',
  PROMO_CODE_EXPIRED: 'This code has expired.',
  PROMO_CODE_NOT_APPLICABLE: 'This code cannot be used on this trip.',
  PROMO_CODE_LIMIT_REACHED: 'This code has reached its limit of uses.',
};

-- A second capture on an already paid order is flagged for operations.
ALTER TYPE "PaymentReviewReason" ADD VALUE 'DUPLICATE_CAPTURE';

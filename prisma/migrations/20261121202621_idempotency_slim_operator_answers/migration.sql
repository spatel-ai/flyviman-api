-- Three idempotent answers no longer carry passenger names or free text
-- (D-128: idempotent answers hold references only). The answers already kept
-- for replay are cut down to the new shape, built from fields they already
-- hold, so a retry within the window gets what a fresh call answers now.
-- Only finished rows of exactly these routes (scope is
-- `<user>:POST:<route template>:<params>`) that still hold the old shape are
-- touched; a second run matches no row.

-- POST /operator/bookings/:reference/cancel: dropped `passengers`,
-- `specialRequests` and the rest of the detail.
UPDATE "IdempotencyKey"
SET "responseBody" = jsonb_build_object(
  'reference', "responseBody" -> 'reference',
  'status', "responseBody" -> 'status',
  'paymentStatus', "responseBody" -> 'paymentStatus',
  'cancelledAt', "responseBody" -> 'cancelledAt',
  'updatedAt', "responseBody" -> 'updatedAt'
)
WHERE "status" = 'COMPLETED'
  AND "scope" LIKE '%:POST:/api/v1/operator/bookings/:reference/cancel:%'
  AND jsonb_typeof("responseBody") = 'object'
  AND "responseBody" ? 'specialRequests';

-- POST /operator/booking-requests/:reference/accept: dropped
-- `specialRequests`, `messages`, change-request `details` and the rest.
UPDATE "IdempotencyKey"
SET "responseBody" = jsonb_build_object(
  'reference', "responseBody" -> 'reference',
  'status', "responseBody" -> 'status',
  'updatedAt', "responseBody" -> 'updatedAt'
)
WHERE "status" = 'COMPLETED'
  AND "scope" LIKE '%:POST:/api/v1/operator/booking-requests/:reference/accept:%'
  AND jsonb_typeof("responseBody") = 'object'
  AND "responseBody" ? 'specialRequests';

-- POST /quotes/:reference/accept: dropped the operator's free-text
-- `conditions` and the price.
UPDATE "IdempotencyKey"
SET "responseBody" = jsonb_build_object(
  'reference', "responseBody" -> 'reference',
  'bookingReference', "responseBody" -> 'bookingReference',
  'status', "responseBody" -> 'status',
  'updatedAt', "responseBody" -> 'updatedAt'
)
WHERE "status" = 'COMPLETED'
  AND "scope" LIKE '%:POST:/api/v1/quotes/:reference/accept:%'
  AND jsonb_typeof("responseBody") = 'object'
  AND "responseBody" ? 'conditions';

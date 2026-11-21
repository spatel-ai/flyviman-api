-- The pay-order answer no longer carries the customer's name, email and phone
-- (`checkout.prefill`, D-221 amended): idempotent answers hold references
-- only (D-128). Strips the ones already kept for replay. Idempotent: a second
-- run matches no row.
UPDATE "IdempotencyKey"
SET "responseBody" = "responseBody" #- '{checkout,prefill}'
WHERE "responseBody" #> '{checkout,prefill}' IS NOT NULL;

-- The starting cancellation tiers (owner, 2026-11-20, D-172): 72 hours or
-- more before departure, 10% of the price; 24 to 72 hours, 50%; under 24
-- hours or a no-show, 100%. Inserted only where no version exists, so every
-- environment has a table in force and none is overwritten. Finance changes
-- it through `/admin/cancellation-terms`.
INSERT INTO "PricingRule" ("id", "scope", "scopeRef", "type", "config", "priority", "validFrom", "isActive", "version", "createdById", "createdAt")
SELECT gen_random_uuid(), 'PLATFORM', NULL, 'CANCELLATION_TIERS',
       '{"tiers": [{"minHoursBeforeDeparture": 72, "chargePercent": 10}, {"minHoursBeforeDeparture": 24, "chargePercent": 50}, {"minHoursBeforeDeparture": 0, "chargePercent": 100}]}'::jsonb,
       0, now(), true, 1, NULL, now()
WHERE NOT EXISTS (
  SELECT 1 FROM "PricingRule" WHERE "type" = 'CANCELLATION_TIERS'
);

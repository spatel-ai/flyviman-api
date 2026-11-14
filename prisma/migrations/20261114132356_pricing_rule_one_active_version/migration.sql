-- At most one active version per pricing rule key (type, scope, scopeRef).
-- Operator pricing saves were not serialised (security review M2,
-- 2026-11-14): two saves at once could each close version n and create
-- version n+1, leaving two rules in force. The services now take an advisory
-- lock per key; this index is the backstop. Prisma cannot express a partial
-- index with an expression, so it is written by hand (database-design.md).

-- Close any duplicates such a race already left, keeping the newest row of
-- each key, so the index can be built. Closing is how every rule change ends
-- a version (isActive false, validTo set), so history stays explainable.
UPDATE "PricingRule" AS r
SET "isActive" = false,
    "validTo" = now()
FROM (
  SELECT id,
         row_number() OVER (
           PARTITION BY type, scope, COALESCE("scopeRef", '')
           ORDER BY version DESC, "createdAt" DESC, id DESC
         ) AS rank
  FROM "PricingRule"
  WHERE "isActive"
) AS ranked
WHERE r.id = ranked.id
  AND ranked.rank > 1;

CREATE UNIQUE INDEX "PricingRule_one_active_version"
  ON "PricingRule" (type, scope, COALESCE("scopeRef", ''))
  WHERE "isActive";

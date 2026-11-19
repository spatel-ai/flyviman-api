-- Consent rows (what a user agreed to, and when) and PriceCalculation (the
-- traceable record behind every price) are append-only: the trigger stops
-- every role, and `npm run db:grant` derives its revoke list from triggers
-- named *_append_only. Nothing updates or deletes either table. A later
-- delete of a User (Consent cascades) or a Search (PriceCalculation sets
-- searchId to null) is refused by these triggers too.
CREATE FUNCTION "consent_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Consent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Consent_append_only"
  BEFORE UPDATE OR DELETE ON "Consent"
  FOR EACH ROW EXECUTE FUNCTION "consent_append_only"();

CREATE TRIGGER "Consent_no_truncate"
  BEFORE TRUNCATE ON "Consent"
  FOR EACH STATEMENT EXECUTE FUNCTION "consent_append_only"();

CREATE FUNCTION "price_calculation_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PriceCalculation is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PriceCalculation_append_only"
  BEFORE UPDATE OR DELETE ON "PriceCalculation"
  FOR EACH ROW EXECUTE FUNCTION "price_calculation_append_only"();

CREATE TRIGGER "PriceCalculation_no_truncate"
  BEFORE TRUNCATE ON "PriceCalculation"
  FOR EACH STATEMENT EXECUTE FUNCTION "price_calculation_append_only"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "Consent", "PriceCalculation" FROM flyviman_app;
  END IF;
END $$;

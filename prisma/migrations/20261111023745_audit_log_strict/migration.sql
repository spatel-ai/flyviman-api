-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- With the foreign key gone nothing needs to update an audit row, so the
-- exemption for clearing actorId is removed: every UPDATE, DELETE and
-- TRUNCATE is refused.
CREATE OR REPLACE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

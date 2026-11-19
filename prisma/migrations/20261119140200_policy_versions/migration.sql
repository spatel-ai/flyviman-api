-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ NOT NULL,
    "publishedBy" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_slug_version_key" ON "PolicyVersion"("slug", "version");


-- Append-only (a published version is never changed or removed): the
-- trigger stops every role, and `npm run db:grant` derives its revoke list
-- from triggers named *_append_only.
CREATE FUNCTION "policy_version_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PolicyVersion is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PolicyVersion_append_only"
  BEFORE UPDATE OR DELETE ON "PolicyVersion"
  FOR EACH ROW EXECUTE FUNCTION "policy_version_append_only"();

CREATE TRIGGER "PolicyVersion_no_truncate"
  BEFORE TRUNCATE ON "PolicyVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION "policy_version_append_only"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "PolicyVersion" FROM flyviman_app;
  END IF;
END $$;

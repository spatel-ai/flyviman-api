-- Hand-written: Prisma cannot express CHECK constraints.
-- An erased account carries its erasure time and no identifier or password,
-- so nothing can sign in to it or find it by address, and an account is
-- never marked erased without being scrubbed (W5-8b). No existing row is
-- ERASED or has erasedAt, so every row already satisfies it.
ALTER TABLE "User" ADD CONSTRAINT "User_erased_scrubbed" CHECK (
  ("status" = 'ERASED') = ("erasedAt" IS NOT NULL)
  AND (
    "status" <> 'ERASED'
    OR ("email" IS NULL AND "phone" IS NULL AND "passwordHash" IS NULL)
  )
);

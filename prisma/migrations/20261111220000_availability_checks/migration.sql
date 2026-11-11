-- Hand-written: Prisma cannot express CHECK constraints.
-- A slot or block must end after it starts. Without this, a BOOKING block
-- with startsAt = endsAt is an empty range that overlaps nothing, so the
-- exclusion constraint "AvailabilityBlock_booking_no_overlap" would let it in.
ALTER TABLE "AvailabilitySlot"
  ADD CONSTRAINT "AvailabilitySlot_ends_after_starts" CHECK ("endsAt" > "startsAt");

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT "AvailabilityBlock_ends_after_starts" CHECK ("endsAt" > "startsAt");

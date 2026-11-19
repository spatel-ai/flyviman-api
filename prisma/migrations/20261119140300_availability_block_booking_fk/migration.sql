-- W2-5: AvailabilityBlock.bookingId gets the foreign key deferred in W1-5.
-- Until now nothing wrote bookingId, but a value that names no booking would
-- stop the constraint being added, so clear any first.
UPDATE "AvailabilityBlock" b
SET "bookingId" = NULL
WHERE b."bookingId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Booking" k WHERE k.id = b."bookingId");

-- CreateIndex
CREATE INDEX "AvailabilityBlock_bookingId_idx" ON "AvailabilityBlock"("bookingId");

-- AddForeignKey
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

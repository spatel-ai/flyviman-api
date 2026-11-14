-- CreateIndex
CREATE INDEX "PriceCalculation_operatorId_createdAt_idx" ON "PriceCalculation"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "PriceCalculation_createdAt_idx" ON "PriceCalculation"("createdAt");

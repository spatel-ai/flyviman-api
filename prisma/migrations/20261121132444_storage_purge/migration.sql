-- CreateTable
CREATE TABLE "StoragePurge" (
    "id" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "StoragePurge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoragePurge_storageKey_key" ON "StoragePurge"("storageKey");

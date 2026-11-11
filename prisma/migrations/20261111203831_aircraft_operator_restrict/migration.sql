-- DropForeignKey
ALTER TABLE "Aircraft" DROP CONSTRAINT "Aircraft_operatorId_fkey";

-- AddForeignKey
ALTER TABLE "Aircraft" ADD CONSTRAINT "Aircraft_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

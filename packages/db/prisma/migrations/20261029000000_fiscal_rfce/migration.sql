-- CreateEnum
CREATE TYPE "FiscalKind" AS ENUM ('ECF', 'RFCE');

-- AlterTable
ALTER TABLE "fiscal_submission" ADD COLUMN     "kind" "FiscalKind" NOT NULL DEFAULT 'ECF';


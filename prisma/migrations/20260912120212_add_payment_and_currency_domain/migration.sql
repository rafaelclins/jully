-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CARD', 'CASH', 'OTHER');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'BRL';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "currencySnapshot" TEXT;

-- Backfill (Etapa 15): Sessions ja CLOSED congelam a moeda operacional do
-- ambiente atual (BRL). Este UPDATE e obrigatorio ANTES de re-adicionar a
-- CHECK financeira, caso contrario a constraint falharia em linhas CLOSED
-- existentes (currencySnapshot ainda NULL). Sessions OPEN permanecem NULL.
UPDATE "sessions" SET "currencySnapshot" = 'BRL' WHERE "status" = 'CLOSED';

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "restaurantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PaymentMethod",
    "provider" TEXT,
    "providerPaymentId" TEXT,
    "idempotencyKey" UUID NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_sessionId_idx" ON "payments"("sessionId");

-- CreateIndex
CREATE INDEX "payments_restaurantId_idx" ON "payments"("restaurantId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_restaurantId_key" ON "payments"("id", "restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_sessionId_idempotencyKey_key" ON "payments"("sessionId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sessionId_restaurantId_fkey" FOREIGN KEY ("sessionId", "restaurantId") REFERENCES "sessions"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Check
-- Invariante financeira da Etapa 14 + 15 (nivel banco):
--   OPEN   -> todos os snapshots financeiros NULL (incl. moeda)
--   CLOSED -> todos os snapshots financeiros NOT NULL (incl. moeda)
-- Sem a moeda, um CLOSED historico ficaria ambiguo (reinterpretavel); por isso
-- currencySnapshot participa da MESMA constraint. Nao altera nenhum indice
-- existente (sessions_one_open_per_table e demais constraints preservadas).
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_financial_snapshot_consistency";

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_financial_snapshot_consistency" CHECK (
  (("status" = 'CLOSED'::"SessionStatus")
    AND "closedSubtotal" IS NOT NULL
    AND "serviceFeePercentSnapshot" IS NOT NULL
    AND "closedServiceFeeAmount" IS NOT NULL
    AND "closedTotal" IS NOT NULL
    AND "currencySnapshot" IS NOT NULL)
  OR
  (("status" = 'OPEN'::"SessionStatus")
    AND "closedSubtotal" IS NULL
    AND "serviceFeePercentSnapshot" IS NULL
    AND "closedServiceFeeAmount" IS NULL
    AND "closedTotal" IS NULL
    AND "currencySnapshot" IS NULL)
);

-- Partial unique index: no maximo UM pagamento efetivamente PAID por Session
-- (Pagamento integral da Etapa 15). Prisma nao expressa partial unique, por
-- isso foi adicionado manualmente, como sessions_one_open_per_table. Em
-- futuros migrate dev, preservar este indice manualmente.
CREATE UNIQUE INDEX "payments_one_paid_per_session" ON "payments"("sessionId") WHERE "status" = 'PAID';

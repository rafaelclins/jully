-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "closedServiceFeeAmount" DECIMAL(10,2),
ADD COLUMN     "closedSubtotal" DECIMAL(10,2),
ADD COLUMN     "closedTotal" DECIMAL(10,2),
ADD COLUMN     "serviceFeePercentSnapshot" DECIMAL(5,2);

-- Check
-- Invariante da Etapa 14 (nivel banco):
--   OPEN   -> todos os snapshots financeiros NULL
--   CLOSED -> todos os snapshots financeiros NOT NULL
-- Expressa via CHECK pois o Prisma nao modela FKs por status; nao altera
-- nenhum indice existente (sessions_one_open_per_table e as demais
-- constraints multi-tenant sao preservadas).
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_financial_snapshot_consistency" CHECK (
  (("status" = 'CLOSED'::"SessionStatus")
    AND "closedSubtotal" IS NOT NULL
    AND "serviceFeePercentSnapshot" IS NOT NULL
    AND "closedServiceFeeAmount" IS NOT NULL
    AND "closedTotal" IS NOT NULL)
  OR
  (("status" = 'OPEN'::"SessionStatus")
    AND "closedSubtotal" IS NULL
    AND "serviceFeePercentSnapshot" IS NULL
    AND "closedServiceFeeAmount" IS NULL
    AND "closedTotal" IS NULL)
);

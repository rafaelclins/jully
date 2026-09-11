-- AlterTable
-- Tabela vazia (desenvolvimento): colunas NOT NULL sem default sao seguras.
-- Se houvesse Orders existentes, seria necessario default/backfill antes.
ALTER TABLE "orders" ADD COLUMN     "idempotencyKey" UUID NOT NULL,
ADD COLUMN     "requestFingerprint" TEXT NOT NULL;

-- CreateIndex
-- Unicidade da chave de idempotencia no escopo da Session.
-- O indice parcial manual sessions_one_open_per_table (nao expressavel no
-- schema Prisma) e preservado; nenhuma constraint multi-tenant e removida.
CREATE UNIQUE INDEX "orders_sessionId_idempotencyKey_key" ON "orders"("sessionId", "idempotencyKey");
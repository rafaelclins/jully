-- DropForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_restaurantId_fkey";

-- DropForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_tableId_fkey";

-- CreateIndex
-- Unique target da FK composta Session(tableId, restaurantId) -> Table(id, restaurantId).
-- Garante que a Session referencia uma mesa E o restaurante daquela mesa, impedindo cruzamento entre tenants.
CREATE UNIQUE INDEX "tables_id_restaurantId_key" ON "tables"("id", "restaurantId");

-- AddForeignKey
-- FK composta: uma Session so pode existir se "tableId" pertencer ao restaurante "restaurantId".
-- Os onDelete RESTRICT (via tabela primeiro) e o indice parcial sessions_one_open_per_table sao preservados.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tableId_restaurantId_fkey" FOREIGN KEY ("tableId", "restaurantId") REFERENCES "tables"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE;
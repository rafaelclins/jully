-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_orderId_fkey";

-- DropForeignKey
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_productId_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "products" DROP CONSTRAINT "products_categoryId_fkey";

-- AlterTable
-- Tabelas vazias: colunas NOT NULL sem default sao seguras.
ALTER TABLE "order_items" ADD COLUMN "restaurantId" UUID NOT NULL;
ALTER TABLE "orders" ADD COLUMN "restaurantId" UUID NOT NULL;
ALTER TABLE "products" ADD COLUMN "restaurantId" UUID NOT NULL;

-- CreateIndex
-- Targets das FKs compostas: permitem (ColumnX, restaurantId) -> (id, restaurantId).
CREATE UNIQUE INDEX "categories_id_restaurantId_key" ON "categories"("id", "restaurantId");
CREATE UNIQUE INDEX "orders_id_restaurantId_key" ON "orders"("id", "restaurantId");
CREATE UNIQUE INDEX "products_id_restaurantId_key" ON "products"("id", "restaurantId");
CREATE UNIQUE INDEX "sessions_id_restaurantId_key" ON "sessions"("id", "restaurantId");

-- AddForeignKey
-- Product: restaurantId deve corresponder ao da Category.
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_restaurantId_fkey" FOREIGN KEY ("categoryId", "restaurantId") REFERENCES "categories"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Order: restaurantId deve corresponder ao da Session.
ALTER TABLE "orders" ADD CONSTRAINT "orders_sessionId_restaurantId_fkey" FOREIGN KEY ("sessionId", "restaurantId") REFERENCES "sessions"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- OrderItem: o MESMO restaurantId deve satisfazer Order E Product.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_restaurantId_fkey" FOREIGN KEY ("orderId", "restaurantId") REFERENCES "orders"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_restaurantId_fkey" FOREIGN KEY ("productId", "restaurantId") REFERENCES "products"("id", "restaurantId") ON DELETE RESTRICT ON UPDATE CASCADE;
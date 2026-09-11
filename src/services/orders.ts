import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateOpenSessionForTable } from "@/services/sessions";
import { getTableByQrToken } from "@/services/tables";

export const MAX_ORDER_ITEM_QUANTITY = 99;

export type CreateOrderInputItem = {
  productId: string;
  quantity: number;
};

export type CreatedOrderDto = {
  id: string;
  status: string;
  createdAt: Date;
  items: {
    productId: string;
    productName: string;
    unitPrice: string;
    quantity: number;
    subtotal: string;
  }[];
  subtotal: string;
};

export type CreateOrderResult =
  | { outcome: "created"; order: CreatedOrderDto }
  | { outcome: "table-not-found" }
  | { outcome: "table-inactive" }
  | { outcome: "menu-changed" }
  | { outcome: "quantity-over-limit" };

function normalizeQuantities(
  items: CreateOrderInputItem[]
):
  | { ok: true; entries: CreateOrderInputItem[] }
  | { ok: false } {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const total = (quantities.get(item.productId) ?? 0) + item.quantity;
    if (total > MAX_ORDER_ITEM_QUANTITY) {
      return { ok: false };
    }
    quantities.set(item.productId, total);
  }
  return {
    ok: true,
    entries: [...quantities.entries()].map(([productId, quantity]) => ({
      productId,
      quantity,
    })),
  };
}

export const orderPublicSelect = {
  id: true,
  sessionId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrderSelect;

export type OrderPublic = Prisma.OrderGetPayload<{
  select: typeof orderPublicSelect;
}>;

const orderItemPublicSelect = {
  id: true,
  productId: true,
  productName: true,
  unitPrice: true,
  quantity: true,
  subtotal: true,
} satisfies Prisma.OrderItemSelect;

export const orderWithItemsSelect = {
  ...orderPublicSelect,
  items: { select: orderItemPublicSelect },
} satisfies Prisma.OrderSelect;

export type OrderWithItems = Prisma.OrderGetPayload<{
  select: typeof orderWithItemsSelect;
}>;

export async function getOrderById({
  restaurantId,
  orderId,
}: {
  restaurantId: string;
  orderId: string;
}): Promise<OrderWithItems | null> {
  return prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: orderWithItemsSelect,
  });
}

export async function listOrdersBySessionId({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<OrderWithItems[]> {
  return prisma.order.findMany({
    where: { sessionId, restaurantId },
    select: orderWithItemsSelect,
    orderBy: { createdAt: "asc" },
  });
}

export async function createOrderForTableQrToken(
  qrToken: string,
  items: CreateOrderInputItem[]
): Promise<CreateOrderResult> {
  const table = await getTableByQrToken(qrToken);
  if (!table) {
    return { outcome: "table-not-found" };
  }
  if (!table.active) {
    return { outcome: "table-inactive" };
  }

  const restaurantId = table.restaurant.id;

  const normalized = normalizeQuantities(items);
  if (!normalized.ok) {
    return { outcome: "quantity-over-limit" };
  }

  const { session } = await getOrCreateOpenSessionForTable({
    restaurantId,
    tableId: table.id,
  });

  const productIds = normalized.entries.map((entry) => entry.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, restaurantId, active: true },
  });
  if (products.length !== productIds.length) {
    return { outcome: "menu-changed" };
  }
  const productsById = new Map(products.map((product) => [product.id, product]));

  const { order, orderItems } = await prisma.$transaction(async (tx) => {
    const createdOrder = await tx.order.create({
      data: {
        sessionId: session.id,
        restaurantId,
      },
    });

    await tx.orderItem.createMany({
      data: normalized.entries.map((entry) => {
        const product = productsById.get(entry.productId);
        if (!product) {
          throw new Error(
            `Product ${entry.productId} resolved but missing after lookup`
          );
        }
        return {
          orderId: createdOrder.id,
          productId: product.id,
          restaurantId,
          productName: product.name,
          unitPrice: product.price,
          quantity: entry.quantity,
          subtotal: product.price.mul(entry.quantity),
        };
      }),
    });

    const createdItems = await tx.orderItem.findMany({
      where: { orderId: createdOrder.id, restaurantId },
      orderBy: { productName: "asc" },
    });

    return { order: createdOrder, orderItems: createdItems };
  });

  const subtotal = orderItems.reduce(
    (acc, item) => acc.add(item.subtotal),
    new Prisma.Decimal(0)
  );

  return {
    outcome: "created",
    order: {
      id: order.id,
      status: order.status,
      createdAt: order.createdAt,
      items: orderItems.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        unitPrice: item.unitPrice.toFixed(2),
        quantity: item.quantity,
        subtotal: item.subtotal.toFixed(2),
      })),
      subtotal: subtotal.toFixed(2),
    },
  };
}
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

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
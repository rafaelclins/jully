import { z } from "zod";

import { OrderStatus } from "@/generated/prisma/client";
import { errorResponse } from "@/lib/public-api";
import { updateOrderStatus } from "@/services/orders";
import { getRestaurantBySlug } from "@/services/restaurants";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

const orderIdSchema = z.string().trim().min(1).max(64).uuid();

// Body estrito: somente { status }. Nada mais e aceito (sem restaurantId,
// sem outros campos). CANCELLED e aceito no payload mas rejeitado pela
// maquina de estados (nenhuma transicao permite -> CANCELLED).
const statusBodySchema = z
  .object({
    status: z.enum([
      OrderStatus.PENDING,
      OrderStatus.PREPARING,
      OrderStatus.READY,
      OrderStatus.CANCELLED,
    ]),
  })
  .strict();

// PATCH /api/restaurant/[restaurantSlug]/orders/[orderId]/status
// Transicao condicional e tenant-scoped. Confirmadas:
//   PENDING -> PREPARING
//   PREPARING -> READY
// Qualquer outra transicao e rejeitada no backend (maquina de estados).
export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ restaurantSlug: string; orderId: string }> }
) {
  const { restaurantSlug, orderId } = await params;

  const parsedSlug = slugSchema.safeParse(restaurantSlug);
  if (!parsedSlug.success) {
    return errorResponse(400, "Invalid restaurant slug");
  }

  const parsedOrderId = orderIdSchema.safeParse(orderId);
  if (!parsedOrderId.success) {
    return errorResponse(400, "Invalid order id");
  }

  const restaurant = await getRestaurantBySlug(parsedSlug.data);
  if (!restaurant) {
    return errorResponse(404, "Restaurant not found", "RESTAURANT_NOT_FOUND");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const parsedBody = statusBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "Invalid status payload");
  }

  let result: Awaited<ReturnType<typeof updateOrderStatus>>;
  try {
    result = await updateOrderStatus({
      restaurantId: restaurant.id,
      orderId: parsedOrderId.data,
      status: parsedBody.data.status,
    });
  } catch (error) {
    console.error("[panel] failed to update order status:", error);
    return errorResponse(500, "Internal server error");
  }

  switch (result.outcome) {
    case "order-not-found":
      // Tambem cobre pedido de outro tenant: nao confirmar existencia.
      return errorResponse(404, "Order not found", "ORDER_NOT_FOUND");
    case "invalid-transition":
      return errorResponse(
        409,
        "This status transition is not allowed",
        "INVALID_STATUS_TRANSITION"
      );
    case "status-conflict":
      return errorResponse(
        409,
        "The order status changed meanwhile. Reload the list.",
        "ORDER_STATUS_CONFLICT"
      );
    case "updated":
      return Response.json({
        order: {
          id: result.id,
          status: result.status,
          updatedAt: result.updatedAt,
        },
      });
  }
}
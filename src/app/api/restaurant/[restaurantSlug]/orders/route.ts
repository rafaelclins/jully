import { z } from "zod";

import { errorResponse } from "@/lib/public-api";
import { requireRestaurantAccess } from "@/lib/require-restaurant-access";
import {
  listOperationalOrdersByRestaurantId,
  OperationalOrdersLimitError,
} from "@/services/orders";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

// GET /api/restaurant/[restaurantSlug]/orders
// Lista apenas pedidos operacionais (PENDING/PREPARING/READY) do restaurante
// para um operador AUTENTICADO com membership no tenant.
//   - sem sessao                -> 401 UNAUTHORIZED
//   - restaurante inexistente OU sem membership -> 404 RESTAURANT_NOT_FOUND
//     (respostas identicas: nao revela tenants para quem nao tem acesso)
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ restaurantSlug: string }> }
) {
  const { restaurantSlug } = await params;

  const parsedSlug = slugSchema.safeParse(restaurantSlug);
  if (!parsedSlug.success) {
    return errorResponse(400, "Invalid restaurant slug");
  }

  const access = await requireRestaurantAccess(parsedSlug.data);
  if (!access.ok && access.reason === "unauthenticated") {
    return errorResponse(401, "Unauthorized");
  }
  if (!access.ok) {
    return errorResponse(404, "Restaurant not found", "RESTAURANT_NOT_FOUND");
  }

  let orders: Awaited<
    ReturnType<typeof listOperationalOrdersByRestaurantId>
  >;
  try {
    orders = await listOperationalOrdersByRestaurantId(
      access.context.restaurantId
    );
  } catch (error) {
    if (error instanceof OperationalOrdersLimitError) {
      return errorResponse(
        503,
        "Operational order list is too large",
        "OPERATIONAL_ORDERS_LIMIT"
      );
    }
    console.error("[panel] failed to list operational orders:", error);
    return errorResponse(500, "Internal server error");
  }

  return Response.json({
    restaurant: {
      id: access.context.restaurantId,
      name: access.context.restaurantName,
      slug: access.context.restaurantSlug,
    },
    orders,
  });
}

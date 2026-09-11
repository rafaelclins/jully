import { z } from "zod";

import { errorResponse } from "@/lib/public-api";
import { listOperationalOrdersByRestaurantId } from "@/services/orders";
import { getRestaurantBySlug } from "@/services/restaurants";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

// GET /api/restaurant/[restaurantSlug]/orders
// Lista apenas pedidos operacionais (PENDING/PREPARING/READY) do restaurante.
// O slug resolve apenas o restaurante — nao e autorizacao.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ restaurantSlug: string }> }
) {
  const { restaurantSlug } = await params;

  const parsedSlug = slugSchema.safeParse(restaurantSlug);
  if (!parsedSlug.success) {
    return errorResponse(400, "Invalid restaurant slug");
  }

  const restaurant = await getRestaurantBySlug(parsedSlug.data);
  if (!restaurant) {
    return errorResponse(404, "Restaurant not found", "RESTAURANT_NOT_FOUND");
  }

  let orders: Awaited<
    ReturnType<typeof listOperationalOrdersByRestaurantId>
  >;
  try {
    orders = await listOperationalOrdersByRestaurantId(restaurant.id);
  } catch (error) {
    console.error("[panel] failed to list operational orders:", error);
    return errorResponse(500, "Internal server error");
  }

  return Response.json({
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
    },
    orders,
  });
}
import { z } from "zod";

import { errorResponse, toRestaurantDto } from "@/lib/public-api";
import { getActiveMenuByRestaurantId } from "@/services/menus";
import { getRestaurantBySlug } from "@/services/restaurants";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) {
    return errorResponse(400, "Invalid restaurant slug");
  }

  const restaurant = await getRestaurantBySlug(parsed.data);
  if (!restaurant) {
    return errorResponse(404, "Restaurant not found");
  }

  const categories = await getActiveMenuByRestaurantId(restaurant.id);

  return Response.json({
    restaurant: toRestaurantDto(restaurant),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      position: category.position,
      products: category.products.map((product) => ({
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price.toFixed(2),
        image: product.image,
      })),
    })),
  });
}
import { notFound } from "next/navigation";

import { OrdersPanel } from "@/components/panel/orders-panel";
import { getRestaurantBySlug } from "@/services/restaurants";

export const dynamic = "force-dynamic";

const RESTAURANT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

// /restaurant/[restaurantSlug]/orders
// Painel operacional do restaurante. O slug resolve apenas o restaurante;
// nao e autorizacao. Pagina controlada: slug invalido ou inexistente -> 404.
export default async function RestaurantOrdersPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;

  if (!RESTAURANT_SLUG_PATTERN.test(restaurantSlug)) {
    notFound();
  }

  let restaurant: Awaited<ReturnType<typeof getRestaurantBySlug>>;
  try {
    restaurant = await getRestaurantBySlug(restaurantSlug);
  } catch {
    notFound();
  }

  if (!restaurant) {
    notFound();
  }

  return (
    <OrdersPanel
      restaurantSlug={restaurant.slug}
      restaurantName={restaurant.name}
    />
  );
}
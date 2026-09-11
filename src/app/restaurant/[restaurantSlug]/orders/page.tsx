import { notFound, redirect } from "next/navigation";

import { OrdersPanel } from "@/components/panel/orders-panel";
import { requireRestaurantAccess } from "@/lib/require-restaurant-access";

export const dynamic = "force-dynamic";

const RESTAURANT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

// /restaurant/[restaurantSlug]/orders
// Painel operacional do restaurante — exige sessao valida + membership.
//   - sem sessao              -> /login
//   - slug invalido/inexistente ou sem membership -> 404 (nao revela tenant).
// Toda operacao posterior usa restaurant.id (obtido do contexto autorizado).
export default async function RestaurantOrdersPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;

  if (!RESTAURANT_SLUG_PATTERN.test(restaurantSlug)) {
    notFound();
  }

  const access = await requireRestaurantAccess(restaurantSlug);

  if (!access.ok && access.reason === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(`/restaurant/${restaurantSlug}/orders`)}`);
  }
  if (!access.ok) {
    notFound();
  }

  return (
    <OrdersPanel
      restaurantSlug={access.context.restaurantSlug}
      restaurantName={access.context.restaurantName}
    />
  );
}
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import {
  getMembershipByUserAndRestaurant,
  type Membership,
} from "@/services/memberships";
import { getRestaurantBySlug } from "@/services/restaurants";

export type RestaurantAccessResult =
  | {
      ok: true;
      context: {
        userId: string;
        restaurantId: string;
        restaurantSlug: string;
        restaurantName: string;
        role: Membership["role"];
      };
    }
  | { ok: false; reason: "unauthenticated" | "restaurant-not-found" | "no-membership" };

// Autorizacao central da superficie operacional do restaurante.
//
// Regra fundamental: permitir APENAS quando
//   session.user.id + Restaurant.id + RestaurantMembership existem.
// Slug resolve apenas o restaurante — nunca e autorizacao.
//
// Politica de resposta (nao revela tenants para quem nao tem acesso):
//   - "unauthenticated"       -> HTTP 401 (API) / redirect /login (pagina).
//   - "restaurant-not-found"  -> mesmo resultado de "no-membership" no HTTP:
//                             404 RESTAURANT_NOT_FOUND, sem distinguir se o
//                             restaurante existe (evita enumeracao).
//   - "no-membership"         -> idem 404 (identico ao inexistente).
//
// A validacao de formato do slug (regex) deve ficar no chamador: um slug
// malformado tambem retorna 404, mas como requisicao invalida.
export async function requireRestaurantAccess(
  restaurantSlug: string
): Promise<RestaurantAccessResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { ok: false, reason: "unauthenticated" };
  }

  const restaurant = await getRestaurantBySlug(restaurantSlug);
  if (!restaurant) {
    return { ok: false, reason: "restaurant-not-found" };
  }

  const membership = await getMembershipByUserAndRestaurant({
    userId: session.user.id,
    restaurantId: restaurant.id,
  });
  if (!membership) {
    return { ok: false, reason: "no-membership" };
  }

  return {
    ok: true,
    context: {
      userId: session.user.id,
      restaurantId: restaurant.id,
      restaurantSlug: restaurant.slug,
      restaurantName: restaurant.name,
      role: membership.role,
    },
  };
}
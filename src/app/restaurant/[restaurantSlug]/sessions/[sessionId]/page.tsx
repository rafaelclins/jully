import { notFound, redirect } from "next/navigation";

import { SessionSummaryView } from "@/components/panel/session-summary";
import { requireRestaurantAccess } from "@/lib/require-restaurant-access";
import { getSessionSummary } from "@/services/sessions";

export const dynamic = "force-dynamic";

const RESTAURANT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /restaurant/[restaurantSlug]/sessions/[sessionId]
// Conta da mesa (resumo financeiro + fechamento). Exige sessao + membership.
//   - sem sessao  -> /login
//   - slug invalido/inexistente/sem membership ou Session fora do tenant
//     -> 404 (nao revela existencia).
export default async function RestaurantSessionPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string; sessionId: string }>;
}) {
  const { restaurantSlug, sessionId } = await params;

  if (!RESTAURANT_SLUG_PATTERN.test(restaurantSlug)) {
    notFound();
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    notFound();
  }

  const access = await requireRestaurantAccess(restaurantSlug);

  if (!access.ok && access.reason === "unauthenticated") {
    redirect(
      `/login?next=${encodeURIComponent(
        `/restaurant/${restaurantSlug}/sessions/${sessionId}`
      )}`
    );
  }
  if (!access.ok) {
    notFound();
  }

  const summary = await getSessionSummary({
    restaurantId: access.context.restaurantId,
    sessionId,
  });
  if (!summary) {
    notFound();
  }

  return (
    <SessionSummaryView
      restaurantSlug={access.context.restaurantSlug}
      sessionId={sessionId}
      initialSummary={summary}
    />
  );
}
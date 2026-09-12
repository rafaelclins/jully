import { z } from "zod";

import { errorResponse } from "@/lib/public-api";
import { requireRestaurantAccess } from "@/lib/require-restaurant-access";
import { getSessionSummary } from "@/services/sessions";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

const sessionIdSchema = z.string().trim().min(1).max(64).uuid();

// GET /api/restaurant/[restaurantSlug]/sessions/[sessionId]/summary
// Resumo financeiro da mesa para operador AUTENTICADO com membership.
//   - sem sessao      -> 401 UNAUTHORIZED
//   - slug inexistente OU sem membership -> 404 RESTAURANT_NOT_FOUND
//   - Session de outro tenant OU inexistente -> 404 SESSION_NOT_FOUND
// Financeiro: subtotal = soma dos OrderItem.subtotal (snapshots historicos)
// dos pedidos PENDING/PREPARING/READY; CANCELLED fica de fora; taxa de
// servico = configuracao atual do Restaurant no momento da consulta.
export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ restaurantSlug: string; sessionId: string }> }
) {
  const { restaurantSlug, sessionId } = await params;

  const parsedSlug = slugSchema.safeParse(restaurantSlug);
  if (!parsedSlug.success) {
    return errorResponse(400, "Invalid restaurant slug");
  }

  const parsedSessionId = sessionIdSchema.safeParse(sessionId);
  if (!parsedSessionId.success) {
    return errorResponse(400, "Invalid session id");
  }

  const access = await requireRestaurantAccess(parsedSlug.data);
  if (!access.ok && access.reason === "unauthenticated") {
    return errorResponse(401, "Unauthorized");
  }
  if (!access.ok) {
    return errorResponse(404, "Restaurant not found", "RESTAURANT_NOT_FOUND");
  }

  let summary: Awaited<ReturnType<typeof getSessionSummary>>;
  try {
    summary = await getSessionSummary({
      restaurantId: access.context.restaurantId,
      sessionId: parsedSessionId.data,
    });
  } catch (error) {
    console.error("[panel] failed to get session summary:", error);
    return errorResponse(500, "Internal server error");
  }

  if (!summary) {
    // Tambem cobre Session de outro tenant: nao confirmar existencia.
    return errorResponse(
      404,
      "Session not found",
      "SESSION_NOT_FOUND"
    );
  }

  return Response.json({ summary });
}
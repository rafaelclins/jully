import { z } from "zod";

import { errorResponse } from "@/lib/public-api";
import { requireRestaurantAccess } from "@/lib/require-restaurant-access";
import {
  closeSession,
  SessionSummaryIntegrityError,
} from "@/services/sessions";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

const sessionIdSchema = z.string().trim().min(1).max(64).uuid();

const emptyBodySchema = z.object({}).strict();

// POST /api/restaurant/[restaurantSlug]/sessions/[sessionId]/close
// Fechamento da mesa para operador AUTENTICADO com membership.
//   - sem sessao      -> 401 UNAUTHORIZED
//   - slug inexistente OU sem membership -> 404 RESTAURANT_NOT_FOUND
//   - Session inexistente/cross-tenant -> 404 SESSION_NOT_FOUND
//   - Order PENDING/PREPARING na Session -> 409 SESSION_HAS_ACTIVE_ORDERS
// Idempotente: retry (ou corrida) retorna a Session CLOSED com o MESMO
// resumo e o MESMO closedAt. Body estrito vazio (sem conteudo).
export async function POST(
  request: Request,
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

  const rawText = await request.text();
  if (rawText.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      return errorResponse(400, "Invalid close payload");
    }
    const parsedBody = emptyBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return errorResponse(400, "Invalid close payload");
    }
  }

  let result: Awaited<ReturnType<typeof closeSession>>;
  try {
    result = await closeSession({
      restaurantId: access.context.restaurantId,
      sessionId: parsedSessionId.data,
    });
  } catch (error) {
    if (error instanceof SessionSummaryIntegrityError) {
      console.error(
        "[panel] close-session integrity violation: CLOSED session with incomplete financial snapshot",
        error
      );
    } else {
      console.error("[panel] failed to close session:", error);
    }
    return errorResponse(500, "Internal server error");
  }

  switch (result.outcome) {
    case "not-found":
      // Tambem cobre Session de outro tenant: nao confirmar existencia.
      return errorResponse(404, "Session not found", "SESSION_NOT_FOUND");
    case "has-orders-in-progress":
      return errorResponse(
        409,
        "Ainda existem pedidos em andamento",
        "SESSION_HAS_ACTIVE_ORDERS"
      );
    case "closed":
    case "already-closed":
      // Resposta identica em ambos os casos: fechamento idempotente.
      return Response.json({ summary: result.summary });
  }
}
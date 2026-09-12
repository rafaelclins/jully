import { z } from "zod";

import { PaymentMethod } from "@/generated/prisma/client";
import { errorResponse } from "@/lib/public-api";
import { requireRestaurantAccess } from "@/lib/require-restaurant-access";
import { resolveRuntimePaymentProvider } from "@/payment-provider/registry";
import { initiatePayment } from "@/services/payments";
import { SessionSummaryIntegrityError } from "@/services/sessions";

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" });

const sessionIdSchema = z.string().trim().min(1).max(64).uuid();

// Body estrito (seção 25): método + chave de idempotência fornecidos pelo
// ATOR (operador autenticado). QUAISQUER campos além destes são rejeitados:
//   - amount / currency  -> vêm DERIVADOS da Session fechada (server-side);
//   - restaurantId       -> vem da autorização;
//   - sessionId          -> vem do path param e é validado no tenant;
//   - status / providerPaymentId / paidAt -> nunca definidos pelo client.
const paymentBodySchema = z
  .object({
    method: z.enum([
      PaymentMethod.PIX,
      PaymentMethod.CARD,
      PaymentMethod.CASH,
      PaymentMethod.OTHER,
    ]),
    idempotencyKey: z.string().trim().uuid(),
  })
  .strict();

// POST /api/restaurant/[restaurantSlug]/sessions/[sessionId]/payments
// Início de uma tentativa de pagamento. Endpoint autenticado do operador/
// restaurante: um cliente anônimo NUNCA pode marcar pagamento como PAID.
//   - sem sessão                 -> 401 UNAUTHORIZED
//   - restaurante inexistente OU sem membership -> 404 RESTAURANT_NOT_FOUND
//   - Session inexistente/cross-tenant -> 404 SESSION_NOT_FOUND
//   - Session OPEN               -> 409 SESSION_NOT_CLOSED (não fecha sozinha)
//   - sem provider configurado   -> 503 PROVIDER_UNAVAILABLE
//   - replay da mesma key        -> 200 (mesma tentativa)
//   - criação / provider pending -> 201 { payment }
//   - provider pagou imediatamente -> 200 { payment } status PAID
//   - rejeição definitiva        -> 200 { payment } status FAILED
//   - tentativa PENDING engajada / Session já PAID -> 409 (conservador)
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid payment payload");
  }

  const parsedBody = paymentBodySchema.safeParse(body);
  if (!parsedBody.success) {
    // Campos extras (amount/currency/status/...), malformados ou ausentes.
    return errorResponse(400, "Invalid payment payload");
  }

  const resolved = resolveRuntimePaymentProvider();
  if (!resolved.provider) {
    return errorResponse(
      503,
      "Payment provider not configured",
      "PROVIDER_UNAVAILABLE"
    );
  }

  let result: Awaited<ReturnType<typeof initiatePayment>>;
  try {
    result = await initiatePayment({
      restaurantId: access.context.restaurantId,
      sessionId: parsedSessionId.data,
      idempotencyKey: parsedBody.data.idempotencyKey,
      method: parsedBody.data.method,
      provider: resolved.provider,
    });
  } catch (error) {
    if (error instanceof SessionSummaryIntegrityError) {
      console.error(
        "[panel] initiate-payment integrity violation: CLOSED session with incomplete financial snapshot",
        error
      );
    } else {
      console.error("[panel] failed to initiate payment:", error);
    }
    return errorResponse(500, "Internal server error");
  }

  switch (result.outcome) {
    case "session-not-found":
      // Também cobre Session de outro tenant: não confirmar existência.
      return errorResponse(404, "Session not found", "SESSION_NOT_FOUND");
    case "session-not-closed":
      return errorResponse(
        409,
        "A sessão precisa estar fechada para iniciar um pagamento",
        "SESSION_NOT_CLOSED"
      );
    case "payment-already-pending":
      return errorResponse(
        409,
        "Já existe uma tentativa de pagamento em andamento nesta sessão",
        "PAYMENT_ALREADY_PENDING"
      );
    case "payment-already-paid":
      return errorResponse(
        409,
        "Esta sessão já foi paga",
        "PAYMENT_ALREADY_PAID"
      );
    case "one-paid-per-session":
      return errorResponse(
        409,
        "Esta sessão já possui pagamento pago",
        "ONE_PAID_PER_SESSION"
      );
    case "created":
      return Response.json({ payment: result.payment }, { status: 201 });
    case "replayed":
    case "paid":
    case "failed":
      return Response.json({ payment: result.payment });
  }
}
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SessionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertSupportedCurrency } from "@/lib/money/currency";
import { SessionSummaryIntegrityError } from "@/services/sessions";

// ---------- Etapa 15: domínio de pagamento (fronteira, NÃO exposta via HTTP) ----------
//
// Este serviço é a fronteira do domínio de Payment do JULLY. Não existe gateway
// integrado nesta etapa: nenhuma rota HTTP chama estas funções, não há webhook
// e o browser nunca declara pagamento. Testes criam fixtures através deste
// serviço (nível de domínio) ou via SQL (nível de banco).
//
// Invariantes garantidas aqui (e reforçadas no banco por NOT NULL/FK/unique):
//   1. Payment só existe para uma TableSession CLOSED;
//   2. amount = sessions.closedTotal e currency = sessions.currencySnapshot
//      (fonte da verdade: servidor/banco; NUNCA valores do cliente/browser);
//   3. uma Session fechada tem no máximo UM Payment PAID (índice parcial
//      payments_one_paid_per_session);
//   4. idempotência: unique(sessionId, idempotencyKey) — retry da mesma
//      intenção retorna a MESMA tentativa;
//   5. transições: PENDING -> {PAID, FAILED, CANCELLED}; estados finais não
//      retornam para PENDING.
//
// Nenhum dado sensível (número de cartão, CVV, senha, chave de gateway) passa
// por aqui.

export const paymentSelect = {
  id: true,
  restaurantId: true,
  sessionId: true,
  amount: true,
  currency: true,
  status: true,
  method: true,
  provider: true,
  providerPaymentId: true,
  idempotencyKey: true,
  paidAt: true,
  failedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentSelect;

export type PaymentDto = {
  id: string;
  restaurantId: string;
  sessionId: string;
  amount: string;
  currency: string;
  status: string;
  method: string | null;
  provider: string | null;
  providerPaymentId: string | null;
  idempotencyKey: string;
  paidAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

function toDto(payment: PaymentRow): PaymentDto {
  return {
    id: payment.id,
    restaurantId: payment.restaurantId,
    sessionId: payment.sessionId,
    amount: payment.amount.toFixed(2),
    currency: payment.currency,
    status: payment.status,
    method: payment.method,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    idempotencyKey: payment.idempotencyKey,
    paidAt: payment.paidAt?.toISOString() ?? null,
    failedAt: payment.failedAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

function isUniqueViolation(
  error: unknown
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

export type CreatePaymentInput = {
  restaurantId: string;
  sessionId: string;
  idempotencyKey: string;
  method?: PaymentMethod;
  provider?: string;
};

export type CreatePaymentResult =
  | { outcome: "created" | "replayed"; payment: PaymentDto }
  | { outcome: "session-not-found" }
  | { outcome: "session-not-closed" };

// Cria (ou re-use, se a mesma chave de idempotência já existir) uma tentativa
// PENDING de pagamento integral de uma Session CLOSED. amount/currency são
// DERIVADOS da Session fechada — o chamador não pode fixá-los. Cross-tenant
// retorna session-not-found (mesmo shape de session inexistente, sem oráculo).
export async function createPayment({
  restaurantId,
  sessionId,
  idempotencyKey,
  method,
  provider,
}: CreatePaymentInput): Promise<CreatePaymentResult> {
  const session = await prisma.tableSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: { status: true, closedTotal: true, currencySnapshot: true },
  });
  if (!session) {
    return { outcome: "session-not-found" };
  }
  if (session.status !== SessionStatus.CLOSED) {
    return { outcome: "session-not-closed" };
  }
  if (session.closedTotal === null || session.currencySnapshot === null) {
    throw new SessionSummaryIntegrityError(
      `session ${sessionId} is CLOSED but financial snapshot is incomplete; payment refused`
    );
  }
  const currency = assertSupportedCurrency(session.currencySnapshot);

  try {
    const payment = await prisma.payment.create({
      data: {
        restaurantId,
        sessionId,
        amount: session.closedTotal,
        currency,
        idempotencyKey,
        method,
        provider,
        status: PaymentStatus.PENDING,
      },
      select: paymentSelect,
    });
    return { outcome: "created", payment: toDto(payment) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.payment.findFirst({
        where: { sessionId, idempotencyKey, restaurantId },
        select: paymentSelect,
      });
      if (!existing) {
        throw error;
      }
      return { outcome: "replayed", payment: toDto(existing) };
    }
    throw error;
  }
}

export type PaymentTransitionResult =
  | { outcome: "updated"; payment: PaymentDto }
  | { outcome: "already"; payment: PaymentDto }
  | { outcome: "payment-not-found" }
  | { outcome: "invalid-state" }
  | { outcome: "one-paid-per-session" };

const PENDING = PaymentStatus.PENDING;

async function fetchCurrentPayment(
  paymentId: string,
  restaurantId: string
): Promise<PaymentDto | null> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, restaurantId },
    select: paymentSelect,
  });
  return payment ? toDto(payment) : null;
}

// Transição PENDING -> PAID (atômica: WHERE status=PENDING). Casos:
//   - já PAID      -> "already" (idempotente, mesmo pagamento);
//   - PAID em outra tentativa da MESMA Session -> P2002 do índice parcial
//     payments_one_paid_per_session -> "one-paid-per-session" (garantia no
//     banco, inclusive sob concorrência);
//   - FAILED/CANCELLED -> "invalid-state" (terminal não retorna a PENDING).
export async function markPaymentPaid({
  restaurantId,
  paymentId,
}: {
  restaurantId: string;
  paymentId: string;
}): Promise<PaymentTransitionResult> {
  const updated = await prisma.payment
    .updateMany({
      where: {
        id: paymentId,
        restaurantId,
        status: PENDING,
      },
      data: { status: PaymentStatus.PAID, paidAt: new Date() },
    })
    .catch((error) => {
      if (isUniqueViolation(error)) {
        return { conflict: true } as const;
      }
      throw error;
    });

  if ("conflict" in updated) {
    return { outcome: "one-paid-per-session" };
  }

  if (updated.count === 1) {
    const payment = await fetchCurrentPayment(paymentId, restaurantId);
    if (!payment) {
      return { outcome: "payment-not-found" };
    }
    return { outcome: "updated", payment };
  }

  const payment = await fetchCurrentPayment(paymentId, restaurantId);
  if (!payment) {
    return { outcome: "payment-not-found" };
  }
  if (payment.status === PaymentStatus.PAID) {
    return { outcome: "already", payment };
  }
  return { outcome: "invalid-state" };
}

// Transição PENDING -> FAILED.
export async function markPaymentFailed({
  restaurantId,
  paymentId,
}: {
  restaurantId: string;
  paymentId: string;
}): Promise<PaymentTransitionResult> {
  const updated = await prisma.payment.updateMany({
    where: { id: paymentId, restaurantId, status: PENDING },
    data: { status: PaymentStatus.FAILED, failedAt: new Date() },
  });

  if (updated.count === 1) {
    const payment = await fetchCurrentPayment(paymentId, restaurantId);
    if (!payment) {
      return { outcome: "payment-not-found" };
    }
    return { outcome: "updated", payment };
  }

  const payment = await fetchCurrentPayment(paymentId, restaurantId);
  if (!payment) {
    return { outcome: "payment-not-found" };
  }
  if (payment.status === PaymentStatus.FAILED) {
    return { outcome: "already", payment };
  }
  return { outcome: "invalid-state" };
}

// Transição PENDING -> CANCELLED.
export async function markPaymentCancelled({
  restaurantId,
  paymentId,
}: {
  restaurantId: string;
  paymentId: string;
}): Promise<PaymentTransitionResult> {
  const updated = await prisma.payment.updateMany({
    where: { id: paymentId, restaurantId, status: PENDING },
    data: { status: PaymentStatus.CANCELLED },
  });

  if (updated.count === 1) {
    const payment = await fetchCurrentPayment(paymentId, restaurantId);
    if (!payment) {
      return { outcome: "payment-not-found" };
    }
    return { outcome: "updated", payment };
  }

  const payment = await fetchCurrentPayment(paymentId, restaurantId);
  if (!payment) {
    return { outcome: "payment-not-found" };
  }
  if (payment.status === PaymentStatus.CANCELLED) {
    return { outcome: "already", payment };
  }
  return { outcome: "invalid-state" };
}
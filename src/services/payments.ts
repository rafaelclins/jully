import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SessionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { assertSupportedCurrency } from "@/lib/money/currency";
import { logProviderOperation } from "@/payment-provider/logging";
import {
  ProviderDefinitiveError,
  type CreateProviderPaymentResult,
  type PaymentProvider,
} from "@/payment-provider/types";
import {
  SERVICE_FEE_ROUNDING,
  SessionSummaryIntegrityError,
} from "@/services/sessions";

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

const paymentSessionSelect = {
  status: true,
  closedSubtotal: true,
  serviceFeePercentSnapshot: true,
  closedServiceFeeAmount: true,
  closedTotal: true,
  currencySnapshot: true,
} satisfies Prisma.TableSessionSelect;

type PaymentSessionSnapshot = Prisma.TableSessionGetPayload<{
  select: typeof paymentSessionSelect;
}>;

function assertValidClosedSnapshot(
  sessionId: string,
  session: PaymentSessionSnapshot
): asserts session is PaymentSessionSnapshot & {
  closedSubtotal: Prisma.Decimal;
  serviceFeePercentSnapshot: Prisma.Decimal;
  closedServiceFeeAmount: Prisma.Decimal;
  closedTotal: Prisma.Decimal;
  currencySnapshot: string;
} {
  if (
    session.closedSubtotal === null ||
    session.serviceFeePercentSnapshot === null ||
    session.closedServiceFeeAmount === null ||
    session.closedTotal === null ||
    session.currencySnapshot === null
  ) {
    throw new SessionSummaryIntegrityError(
      `session ${sessionId} is CLOSED but financial snapshot is incomplete; payment refused`
    );
  }
  const expectedFee = session.closedSubtotal
    .mul(session.serviceFeePercentSnapshot)
    .div(100)
    .toDecimalPlaces(2, SERVICE_FEE_ROUNDING);
  const expectedTotal = session.closedSubtotal.add(expectedFee);
  if (
    !session.closedServiceFeeAmount.equals(expectedFee) ||
    !session.closedTotal.equals(expectedTotal)
  ) {
    throw new SessionSummaryIntegrityError(
      `session ${sessionId} is CLOSED but financial snapshot is inconsistent; payment refused`
    );
  }
}

export function toPaymentDto(payment: PaymentRow): PaymentDto {
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
    select: paymentSessionSelect,
  });
  if (!session) {
    return { outcome: "session-not-found" };
  }
  if (session.status !== SessionStatus.CLOSED) {
    return { outcome: "session-not-closed" };
  }
  assertValidClosedSnapshot(sessionId, session);
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
    return { outcome: "created", payment: toPaymentDto(payment) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.payment.findFirst({
        where: { sessionId, idempotencyKey, restaurantId },
        select: paymentSelect,
      });
      if (!existing) {
        throw error;
      }
      return { outcome: "replayed", payment: toPaymentDto(existing) };
    }
    throw error;
  }
}

// ---------- Etapa 16: Payment Application Service (início de tentativa) ----------
//
// Fluxo:
//   Session CLOSED (nunca OPEN — sem disparar webhook/checkout em mesa aberta)
//   -> Payment ainda não PAID
//   -> criar/reusar tentativa idempotente (unique(sessionId, idempotencyKey))
//   -> chamar PaymentProvider (adapter, interface abstrata)
//   -> persistir providerPaymentId + estado coerente
//
// amount/currency são DERIVADOS da Session fechada (closedTotal +
// currencySnapshot) — o browser nunca informa valores. Tenância sempre
// server-side (restaurantId vem da autorização). Nenhum dado sensível de
// pagamento trafega aqui.
//
// Timeout/ambiguidade (seção 17): se o provider não confirma o resultado,
// o Payment PERMANECE PENDING — NUNCA FAILED automaticamente (a resposta pode
// ter se perdido após o provider ter cobrado). Fica para reconciliação.

export type InitiatePaymentInput = {
  restaurantId: string;
  sessionId: string;
  idempotencyKey: string;
  method: PaymentMethod;
  provider: PaymentProvider;
};

export type InitiatePaymentResult =
  | { outcome: "created"; payment: PaymentDto }
  | { outcome: "replayed"; payment: PaymentDto }
  | { outcome: "paid"; payment: PaymentDto }
  | { outcome: "failed"; payment: PaymentDto }
  | { outcome: "payment-already-pending"; payment: PaymentDto }
  | { outcome: "payment-already-paid"; payment: PaymentDto }
  | { outcome: "one-paid-per-session"; payment: PaymentDto }
  | { outcome: "session-not-found" }
  | { outcome: "session-not-closed" };

async function persistProviderPaymentId(
  restaurantId: string,
  paymentId: string,
  providerPaymentId: string
): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId, restaurantId },
    data: { providerPaymentId },
  });
}

// Regras conservadoras da primeira versão (seção 19):
//   - mesma idempotencyKey -> MESMA tentativa (replay), sem nova chamada ao
//     provider — o engajamento é exclusivo do criador da tentativa;
//   - FAILED/CANCELLED -> nova idempotencyKey pode criar nova tentativa;
//   - PENDING já engajado no provider (providerPaymentId presente) -> NÃO criar
//     tentativa equivalente (evita cobrança dupla); a reconciliação resolve;
//   - Session já PAID -> nova tentativa bloqueada.
export async function initiatePayment({
  restaurantId,
  sessionId,
  idempotencyKey,
  method,
  provider,
}: InitiatePaymentInput): Promise<InitiatePaymentResult> {
  const session = await prisma.tableSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: paymentSessionSelect,
  });
  if (!session) {
    return { outcome: "session-not-found" };
  }
  if (session.status !== SessionStatus.CLOSED) {
    return { outcome: "session-not-closed" };
  }
  assertValidClosedSnapshot(sessionId, session);
  const currency = assertSupportedCurrency(session.currencySnapshot);

  // Replay idempotente: mesma chave -> mesma tentativa (qualquer status).
  const replayed = await prisma.payment.findFirst({
    where: { sessionId, idempotencyKey, restaurantId },
    select: paymentSelect,
  });
  if (replayed) {
    return { outcome: "replayed", payment: toPaymentDto(replayed) };
  }

  // Bloqueios conservadores (não atômicos; a última barreira é o índice único
  // payments_one_paid_per_session no banco).
  const alreadyPaid = await prisma.payment.findFirst({
    where: {
      sessionId,
      restaurantId,
      status: PaymentStatus.PAID,
    },
    select: paymentSelect,
  });
  if (alreadyPaid) {
    return { outcome: "payment-already-paid", payment: toPaymentDto(alreadyPaid) };
  }
  const engagedPending = await prisma.payment.findFirst({
    where: {
      sessionId,
      restaurantId,
      status: PaymentStatus.PENDING,
      providerPaymentId: { not: null },
    },
    select: paymentSelect,
  });
  if (engagedPending) {
    return {
      outcome: "payment-already-pending",
      payment: toPaymentDto(engagedPending),
    };
  }

  // Criação da tentativa PENDING. unique(sessionId, idempotencyKey) resolve a
  // corrida entre requests concorrentes com a mesma chave: 1 criador, N replays.
  let attempt: PaymentDto;
  try {
    const created = await prisma.payment.create({
      data: {
        restaurantId,
        sessionId,
        amount: session.closedTotal,
        currency,
        idempotencyKey,
        method,
        provider: provider.name,
        status: PaymentStatus.PENDING,
      },
      select: paymentSelect,
    });
    attempt = toPaymentDto(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winning = await prisma.payment.findFirst({
        where: { sessionId, idempotencyKey, restaurantId },
        select: paymentSelect,
      });
      if (winning) {
        return { outcome: "replayed", payment: toPaymentDto(winning) };
      }
    }
    throw error;
  }

  const started = Date.now();
  let providerResult: CreateProviderPaymentResult;
  try {
    providerResult = await provider.createPayment({
      internalPaymentId: attempt.id,
      idempotencyKey,
      amount: attempt.amount,
      currency: attempt.currency,
      method,
    });
    logProviderOperation({
      kind: "create",
      provider: provider.name,
      operation: "createPayment",
      result: providerResult.status,
      durationMs: Date.now() - started,
      internalPaymentId: attempt.id,
    });
  } catch (error) {
    const durationMs = Date.now() - started;
    if (error instanceof ProviderDefinitiveError) {
      // Rejeição definitiva (cartão recusado, método inválido) -> FAILED.
      logProviderOperation({
        kind: "create",
        provider: provider.name,
        operation: "createPayment",
        result: "failed",
        durationMs,
        internalPaymentId: attempt.id,
        failureCode: error.failureCode,
      });
      await markPaymentFailed({ restaurantId, paymentId: attempt.id });
      const current = await fetchCurrentPayment(attempt.id, restaurantId);
      return { outcome: "failed", payment: current ?? attempt };
    }
    // Ambíguo (timeout/reset/5xx) ou exceção inesperada: permanece PENDING.
    // Nunca FAILED — a resposta pode ter se perdido após cobrança no provider.
    logProviderOperation({
      kind: "create",
      provider: provider.name,
      operation: "createPayment",
      result: "ambiguous",
      durationMs,
      internalPaymentId: attempt.id,
      failureCode: error instanceof Error ? error.name : undefined,
    });
    return { outcome: "created", payment: attempt };
  }

  switch (providerResult.status) {
    case "paid": {
      await persistProviderPaymentId(
        restaurantId,
        attempt.id,
        providerResult.providerPaymentId
      );
      const transition = await markPaymentPaid({
        restaurantId,
        paymentId: attempt.id,
      });
      const current = await fetchCurrentPayment(attempt.id, restaurantId);
      if (transition.outcome === "one-paid-per-session") {
        return { outcome: "one-paid-per-session", payment: current ?? attempt };
      }
      return { outcome: "paid", payment: current ?? attempt };
    }
    case "pending": {
      await persistProviderPaymentId(
        restaurantId,
        attempt.id,
        providerResult.providerPaymentId
      );
      const current = await fetchCurrentPayment(attempt.id, restaurantId);
      return { outcome: "created", payment: current ?? attempt };
    }
    case "failed": {
      if (providerResult.providerPaymentId) {
        await persistProviderPaymentId(
          restaurantId,
          attempt.id,
          providerResult.providerPaymentId
        );
      }
      await markPaymentFailed({ restaurantId, paymentId: attempt.id });
      const current = await fetchCurrentPayment(attempt.id, restaurantId);
      return { outcome: "failed", payment: current ?? attempt };
    }
  }
}

export type PaymentTransitionResult =
  | { outcome: "updated"; payment: PaymentDto }
  | { outcome: "already"; payment: PaymentDto }
  | { outcome: "payment-not-found" }
  | { outcome: "invalid-state" }
  | { outcome: "one-paid-per-session"; payment: PaymentDto };

const PENDING = PaymentStatus.PENDING;

async function fetchCurrentPayment(
  paymentId: string,
  restaurantId: string
): Promise<PaymentDto | null> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, restaurantId },
    select: paymentSelect,
  });
  return payment ? toPaymentDto(payment) : null;
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
    const current = await fetchCurrentPayment(paymentId, restaurantId);
    if (!current) {
      return { outcome: "payment-not-found" };
    }
    return { outcome: "one-paid-per-session", payment: current };
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

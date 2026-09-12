import { PaymentStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { logProviderOperation } from "@/payment-provider/logging";
import { getPaymentProvider } from "@/payment-provider/registry";
import type {
  GetProviderPaymentStatusResult,
  PaymentProvider,
} from "@/payment-provider/types";
import {
  markPaymentFailed,
  markPaymentPaid,
  paymentSelect,
  toPaymentDto,
  type PaymentDto,
} from "@/services/payments";

// ---------- Reconciliação (Etapa 16, seção 16) ----------
//
// Payment PENDING há muito tempo -> consulta o provider por providerPaymentId
// -> obtém o status real -> aplica transição segura (state machine atômica).
//
// Nesta etapa NÃO há cron/scheduler/job externo: a função é reutilizável e
// invocável sob demanda (parelha/operador). Integração real só com o
// FakePaymentProvider (nenhum provider real registrado).
//
// Ambiguidade da consulta (timeout/reset/5xx): o Payment PERMANECE PENDING e
// a reconciliação deve ser tentada depois — nunca marca FAILED por não
// conseguir consultar o provider.

export type ReconcilePaymentInput = {
  restaurantId: string;
  paymentId: string;
  // Injeção para determinismo em testes. Quando omitida, o provider é
  // resolvido pelo registro a partir de payment.provider.
  provider?: PaymentProvider;
};

export type ReconcilePaymentResult =
  | { outcome: "paid"; payment: PaymentDto }
  | { outcome: "failed"; payment: PaymentDto }
  | { outcome: "unchanged"; payment: PaymentDto }
  | { outcome: "already-terminal"; payment: PaymentDto }
  | { outcome: "ambiguous"; payment: PaymentDto }
  | { outcome: "cannot-reconcile"; payment: PaymentDto }
  | { outcome: "one-paid-per-session"; payment: PaymentDto }
  | { outcome: "no-regress"; payment: PaymentDto }
  | { outcome: "payment-not-found" };

export async function reconcilePayment({
  restaurantId,
  paymentId,
  provider: injectedProvider,
}: ReconcilePaymentInput): Promise<ReconcilePaymentResult> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, restaurantId },
    select: paymentSelect,
  });
  if (!payment) {
    return { outcome: "payment-not-found" };
  }
  const dto = toPaymentDto(payment);

  // Estados terminais não voltam: nada a reconciliar (evita consulta inútil).
  if (payment.status !== PaymentStatus.PENDING) {
    return { outcome: "already-terminal", payment: dto };
  }

  if (!payment.provider || !payment.providerPaymentId) {
    return { outcome: "cannot-reconcile", payment: dto };
  }

  const provider = injectedProvider ?? getPaymentProvider(payment.provider);
  if (!provider) {
    return { outcome: "cannot-reconcile", payment: dto };
  }

  const started = Date.now();
  let providerStatus: GetProviderPaymentStatusResult;
  try {
    providerStatus = await provider.getPaymentStatus({
      providerPaymentId: payment.providerPaymentId,
    });
    logProviderOperation({
      kind: "reconcile",
      provider: provider.name,
      operation: "getPaymentStatus",
      result: providerStatus.status,
      durationMs: Date.now() - started,
      internalPaymentId: payment.id,
      failureCode:
        providerStatus.status === "failed"
          ? providerStatus.failureCode
          : undefined,
    });
  } catch (error) {
    const durationMs = Date.now() - started;
    logProviderOperation({
      kind: "reconcile",
      provider: provider.name,
      operation: "getPaymentStatus",
      result: "ambiguous",
      durationMs,
      internalPaymentId: payment.id,
      failureCode: error instanceof Error ? error.name : undefined,
    });
    // Timeout/indisponibilidade externa: permanece PENDING (nunca FAILED).
    return { outcome: "ambiguous", payment: dto };
  }

  switch (providerStatus.status) {
    case "paid": {
      const transition = await markPaymentPaid({
        restaurantId,
        paymentId: payment.id,
      });
      switch (transition.outcome) {
        case "updated":
        case "already":
          return { outcome: "paid", payment: transition.payment };
        case "one-paid-per-session":
          return {
            outcome: "one-paid-per-session",
            payment: transition.payment,
          };
        default:
          // payment-not-found / invalid-state: Payment saiu de PENDING durante
          // a consulta (ex.: PAID por outra via). Não regressa.
          return { outcome: "no-regress", payment: dto };
      }
    }
    case "failed": {
      const transition = await markPaymentFailed({
        restaurantId,
        paymentId: payment.id,
      });
      if (
        transition.outcome === "already" ||
        transition.outcome === "updated"
      ) {
        return { outcome: "failed", payment: transition.payment };
      }
      // Payment PAID enquanto a consulta acontecia: não regride para FAILED.
      return { outcome: "no-regress", payment: dto };
    }
    case "pending":
      return { outcome: "unchanged", payment: dto };
  }
}
import { PaymentStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { logProviderOperation } from "@/payment-provider/logging";
import { getWebhookEventMapper } from "@/payment-provider/registry";
import {
  markPaymentFailed,
  markPaymentPaid,
  paymentSelect,
  toPaymentDto,
  type PaymentDto,
} from "@/services/payments";

// ---------- Webhook interno de pagamento (Etapa 16, seções 10-14) ----------
//
// Infraestrutura de webhook genérica, SEM endpoint específico de provider.
// O domínio não conhece payload de gateway: o adapter do provider traduz o
// evento bruto (mapWebhookEventType) para PaymentStatus JULLY (ou null = ruído).
//
// Garantias:
//   - replay protection: unique(provider, providerEventId) em
//     payment_webhook_events — um evento duplicado é processado UMA única vez;
//   - eventos fora de ordem: toda aplicação passa pela state machine atômica
//     (markPaymentPaid/Failed só saem de PENDING). PAID nunca regride para
//     PENDING/FAILED; FAILED não regride para PENDING;
//   - cross-tenant impossível por construção: o evento não carrega tenant; o
//     Payment é resolvido por (provider, providerPaymentId) — identificadores
//     fornecidos pelo provedor, nunca pelo browser;
//   - nenhum payload bruto sensível é armazenado (apenas referências + carimbos).

export const paymentWebhookEventSelect = {
  id: true,
  provider: true,
  providerEventId: true,
  providerPaymentId: true,
  eventType: true,
  occurredAt: true,
  receivedAt: true,
  processedAt: true,
  outcome: true,
} satisfies Prisma.PaymentWebhookEventSelect;

type PaymentWebhookEventRow = Prisma.PaymentWebhookEventGetPayload<{
  select: typeof paymentWebhookEventSelect;
}>;

export type PaymentWebhookEventDto = {
  id: string;
  provider: string;
  providerEventId: string;
  providerPaymentId: string;
  eventType: string;
  occurredAt: string | null;
  receivedAt: string;
  processedAt: string | null;
  outcome: string | null;
};

function toWebhookEventDto(event: PaymentWebhookEventRow): PaymentWebhookEventDto {
  return {
    ...event,
    occurredAt: event.occurredAt?.toISOString() ?? null,
    receivedAt: event.receivedAt.toISOString(),
    processedAt: event.processedAt?.toISOString() ?? null,
  };
}

export type PaymentWebhookInput = {
  provider: string;
  eventId: string;
  providerPaymentId: string;
  eventType: string;
  occurredAt?: string;
};

export type PaymentWebhookResult =
  | { outcome: "applied"; payment: PaymentDto; event: PaymentWebhookEventDto }
  | { outcome: "duplicate"; event: PaymentWebhookEventDto }
  | {
      outcome: "ignored";
      event: PaymentWebhookEventDto;
      reason: "provider-unknown" | "no-payment" | "noise-event" | "no-regress";
    };

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// Marca o evento como processado (idempotente via guarda processedAt: null) e
// retorna o estado final gravado.
async function finalizeEvent(
  eventId: string,
  outcome: string
): Promise<PaymentWebhookEventDto> {
  await prisma.paymentWebhookEvent.updateMany({
    where: { id: eventId, processedAt: null },
    data: { processedAt: new Date(), outcome },
  });
  const row = await prisma.paymentWebhookEvent.findFirst({
    where: { id: eventId },
    select: paymentWebhookEventSelect,
  });
  if (!row) {
    throw new Error("webhook event disappeared after processing");
  }
  return toWebhookEventDto(row);
}

// Aplicação segura de um evento de webhook. Ordem das etapas:
//   1. registro do evento (unique(provider, providerEventId) = replay protection);
//   2. tradução via adapter (provider/evento desconhecido -> ignore);
//   3. resolução do Payment por (provider, providerPaymentId), sem tenant;
//   4. aplicação via state machine atômica (fora de ordem -> sem regressão).
export async function processPaymentWebhookEvent({
  provider,
  eventId,
  providerPaymentId,
  eventType,
  occurredAt,
}: PaymentWebhookInput): Promise<PaymentWebhookResult> {
  const started = Date.now();

  // 1. Registro idempotente do evento (auditoria + replay protection).
  let stored: PaymentWebhookEventRow;
  try {
    stored = await prisma.paymentWebhookEvent.create({
      data: {
        provider,
        providerEventId: eventId,
        providerPaymentId,
        eventType,
        occurredAt: occurredAt ? new Date(occurredAt) : undefined,
      },
      select: paymentWebhookEventSelect,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await prisma.paymentWebhookEvent.findFirst({
        where: { provider, providerEventId: eventId },
        select: paymentWebhookEventSelect,
      });
      if (existing) {
        logProviderOperation({
          kind: "webhook",
          provider,
          operation: "processWebhookEvent",
          result: "duplicate",
          durationMs: Date.now() - started,
        });
        return { outcome: "duplicate", event: toWebhookEventDto(existing) };
      }
      throw error;
    }
    throw error;
  }

  // 2. Tradução pelo adapter do provider (desconhecido no registro -> ignore).
  const mapper = getWebhookEventMapper(provider);
  if (!mapper) {
    logProviderOperation({
      kind: "webhook",
      provider,
      operation: "processWebhookEvent",
      result: "ignored",
      durationMs: Date.now() - started,
    });
    const event = await finalizeEvent(stored.id, "ignored-provider-unknown");
    return { outcome: "ignored", event, reason: "provider-unknown" };
  }
  const mapped = mapper(eventType);
  if (mapped === null) {
    logProviderOperation({
      kind: "webhook",
      provider,
      operation: "processWebhookEvent",
      result: "no-op",
      durationMs: Date.now() - started,
    });
    const event = await finalizeEvent(stored.id, "ignored-noise-event");
    return { outcome: "ignored", event, reason: "noise-event" };
  }

  // 3. Resolução por (provider, providerPaymentId): unicidade garantida pelo
  //    índice único; nenhum dado de tenant vindo do browser/configuração.
  const payment = await prisma.payment.findFirst({
    where: { provider, providerPaymentId },
    select: paymentSelect,
  });
  if (!payment) {
    logProviderOperation({
      kind: "webhook",
      provider,
      operation: "processWebhookEvent",
      result: "ignored",
      durationMs: Date.now() - started,
    });
    const event = await finalizeEvent(stored.id, "ignored-no-payment");
    return { outcome: "ignored", event, reason: "no-payment" };
  }

  // 4. Aplicação via state machine atômica (só sai de PENDING).
  switch (mapped) {
    case PaymentStatus.PAID: {
      const transition = await markPaymentPaid({
        restaurantId: payment.restaurantId,
        paymentId: payment.id,
      });
      switch (transition.outcome) {
        case "updated":
        case "already": {
          const event = await finalizeEvent(stored.id, "applied");
          return { outcome: "applied", payment: transition.payment, event };
        }
        case "one-paid-per-session": {
          // Anomalia rara (dois PAID em tentativas distintas sob concorrência):
          // o banco mantém exatamente um PAID (transition.payment); o evento
          // fica registrado e a divergência é visível para reconciliação.
          const event = await finalizeEvent(
            stored.id,
            "applied-one-paid-per-session-guard"
          );
          return {
            outcome: "applied",
            payment: transition.payment,
            event,
          };
        }
        case "payment-not-found": {
          const event = await finalizeEvent(stored.id, "ignored-no-payment");
          return { outcome: "ignored", event, reason: "no-payment" };
        }
        default: {
          // invalid-state: target não-PENDING (FAILED/CANCELLED). Evento tardio
          // de PAID não promove nem regride — o estado terminal já é a palavra
          // final (divergência vai para reconciliação/auditoria manual).
          const event = await finalizeEvent(stored.id, "no-regress");
          return { outcome: "ignored", event, reason: "no-regress" };
        }
      }
    }
    case PaymentStatus.FAILED: {
      const transition = await markPaymentFailed({
        restaurantId: payment.restaurantId,
        paymentId: payment.id,
      });
      switch (transition.outcome) {
        case "updated":
        case "already": {
          const event = await finalizeEvent(stored.id, "applied");
          return { outcome: "applied", payment: transition.payment, event };
        }
        case "payment-not-found": {
          const event = await finalizeEvent(stored.id, "ignored-no-payment");
          return { outcome: "ignored", event, reason: "no-payment" };
        }
        default: {
          // invalid-state: Payment já PAID/CANCELLED — PAID nunca regride.
          const event = await finalizeEvent(stored.id, "no-regress");
          return { outcome: "ignored", event, reason: "no-regress" };
        }
      }
    }
    default:
      // PENDING não é evento transiente aplicável: Payment recém-criado já é
      // PENDING (no-op). Se o Payment já atingiu estado terminal, um evento
      // tardio de PENDING não regride.
      {
        const current = await prisma.payment.findFirst({
          where: { id: payment.id, restaurantId: payment.restaurantId },
          select: paymentSelect,
        });
        if (!current || current.status !== PaymentStatus.PENDING) {
          const event = await finalizeEvent(stored.id, "no-regress");
          return { outcome: "ignored", event, reason: "no-regress" };
        }
        const event = await finalizeEvent(stored.id, "applied");
        return { outcome: "applied", payment: toPaymentDto(current), event };
      }
  }
}
import { PaymentStatus } from "@/generated/prisma/client";
import {
  ProviderAmbiguousError,
  ProviderDefinitiveError,
  type CreateProviderPaymentInput,
  type CreateProviderPaymentResult,
  type GetProviderPaymentStatusInput,
  type GetProviderPaymentStatusResult,
  type PaymentProvider,
} from "@/payment-provider/types";

// ---------- FakePaymentProvider (Etapa 16, seção 6) ----------
//
// Provedor fictício para testes e validação da arquitetura. NUNCA chama APIs
// externas, nunca usa rede, nunca move dinheiro real. Comportamento
// determinístico e configurável por cenário:
//   - create: pending | paid | failed | ambiguous (timeout/network) |
//             exception (inesperada) | definitive-error (rejeição definitiva);
//   - status: pending | paid | failed | ambiguous | exception.
//
// O comportamento pode ser uma função (input) => behavior, permitindo rotear
// cenários por chave/valor, se o teste precisar (ex.: status "paid" apenas
// para um providerPaymentId específico).

export const FAKE_PROVIDER_NAME = "fake";

export type FakeProviderBehavior =
  | { kind: "pending"; providerPaymentId?: string }
  | { kind: "paid"; providerPaymentId?: string }
  | {
      kind: "failed";
      providerPaymentId?: string;
      failureCode?: string;
    }
  // Tempo de espera estourado / rede caiu após submissão: ambiguidade real.
  | { kind: "ambiguous"; failureCode?: string }
  // Exceção não esperada pelo adapter (tratada como ambiguidade).
  | { kind: "exception" }
  // Rejeição definitiva e sem ambiguidade (ex.: recusa do cartão).
  | { kind: "definitive-error"; failureCode?: string };

export type FakeProviderBehaviorSource =
  | FakeProviderBehavior
  | ((input: CreateProviderPaymentInput | GetProviderPaymentStatusInput) => FakeProviderBehavior);

export type FakeWebhookEventType = "payment.pending" | "payment.paid" | "payment.failed";

export const FAKE_EVENT_PENDING: FakeWebhookEventType = "payment.pending";
export const FAKE_EVENT_PAID: FakeWebhookEventType = "payment.paid";
export const FAKE_EVENT_FAILED: FakeWebhookEventType = "payment.failed";

function resolveBehavior(
  source: FakeProviderBehaviorSource,
  input: CreateProviderPaymentInput | GetProviderPaymentStatusInput
): FakeProviderBehavior {
  return typeof source === "function" ? source(input) : source;
}

function defaultProviderPaymentId(internalPaymentId: string): string {
  // Determinístico por internalPaymentId: único por Payment (UUID), então o
  // providerPaymentId resultante também é único dentro do provider "fake".
  return `fake_${internalPaymentId}`;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly name = FAKE_PROVIDER_NAME;

  // Contadores de chamadas (asserções de idempotência/concorrência nos testes).
  createCalls = 0;
  statusCalls = 0;

  constructor(
    private readonly createBehavior: FakeProviderBehaviorSource = { kind: "pending" },
    private readonly statusBehavior: FakeProviderBehaviorSource = { kind: "pending" }
  ) {}

  async createPayment(
    input: CreateProviderPaymentInput
  ): Promise<CreateProviderPaymentResult> {
    this.createCalls += 1;
    const behavior = resolveBehavior(this.createBehavior, input);
    switch (behavior.kind) {
      case "pending":
        return {
          status: "pending",
          providerPaymentId:
            behavior.providerPaymentId ?? defaultProviderPaymentId(input.internalPaymentId),
        };
      case "paid":
        return {
          status: "paid",
          providerPaymentId:
            behavior.providerPaymentId ?? defaultProviderPaymentId(input.internalPaymentId),
        };
      case "failed":
        return {
          status: "failed",
          ...(behavior.providerPaymentId
            ? { providerPaymentId: behavior.providerPaymentId }
            : {}),
          failureCode: behavior.failureCode ?? "FAKE_DECLINE",
        };
      case "ambiguous":
        throw new ProviderAmbiguousError(
          "fake provider: ambiguous result (timeout/network)",
          behavior.failureCode
        );
      case "exception":
        throw new Error("fake provider: unexpected exception");
      case "definitive-error":
        throw new ProviderDefinitiveError(
          "fake provider: definitive rejection",
          behavior.failureCode
        );
    }
  }

  async getPaymentStatus(
    input: GetProviderPaymentStatusInput
  ): Promise<GetProviderPaymentStatusResult> {
    this.statusCalls += 1;
    const behavior = resolveBehavior(this.statusBehavior, input);
    switch (behavior.kind) {
      case "pending":
        return { status: "pending" };
      case "paid":
        return { status: "paid" };
      case "failed":
        return { status: "failed", failureCode: behavior.failureCode ?? "FAKE_DECLINE" };
      case "ambiguous":
        throw new ProviderAmbiguousError(
          "fake provider: ambiguous status (timeout)",
          behavior.failureCode
        );
      case "exception":
        throw new Error("fake provider: unexpected exception on status");
      case "definitive-error":
        throw new ProviderDefinitiveError(
          "fake provider: definitive rejection on status",
          behavior.failureCode
        );
    }
  }

  mapWebhookEventType(eventType: string): PaymentStatus | null {
    switch (eventType) {
      case FAKE_EVENT_PENDING:
        return PaymentStatus.PENDING;
      case FAKE_EVENT_PAID:
        return PaymentStatus.PAID;
      case FAKE_EVENT_FAILED:
        return PaymentStatus.FAILED;
      default:
        return null;
    }
  }
}
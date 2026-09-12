import type { PaymentMethod, PaymentStatus } from "@/generated/prisma/client";

// ---------- Payment Provider Boundary (Etapa 16) ----------
//
// Fronteira arquitetural entre o domínio financeiro do JULLY e provedores de
// pagamento (Mercado Pago, Stripe, Stone, Cielo, PIX PSP etc.). Esta etapa NÃO
// integra nenhum provedor real: os tipos abaixo são o contrato que um adapter
// futuro implementa. O domínio do JULLY conhece apenas estas abstrações —
// nunca payload específico de gateway (preference_id, PaymentIntent,
// payment_method_id etc. pertencem ao adapter).

export type ProviderPaymentStatus = "pending" | "paid" | "failed";

// ---------------------------------------------------------------------------
// Criação de tentativa no provedor.
// amount/currency são STRINGS decimais exatas derivadas do servidor
// (closedTotal + currencySnapshot). O gateway nunca vê valores do browser.
// ---------------------------------------------------------------------------
export type CreateProviderPaymentInput = {
  internalPaymentId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  method: PaymentMethod;
};

export type CreateProviderPaymentResult =
  | {
      status: "pending";
      providerPaymentId: string;
    }
  | {
      status: "paid";
      providerPaymentId: string;
    }
  | {
      status: "failed";
      providerPaymentId?: string;
      failureCode?: string;
    };

// ---------------------------------------------------------------------------
// Consulta de status no provedor (reconciliação / poll).
// ---------------------------------------------------------------------------
export type GetProviderPaymentStatusInput = {
  providerPaymentId: string;
};

export type GetProviderPaymentStatusResult =
  | { status: "pending"; occurredAt?: string }
  | { status: "paid"; occurredAt?: string }
  | { status: "failed"; failureCode?: string; occurredAt?: string };

export interface PaymentProvider {
  readonly name: string;

  createPayment(
    input: CreateProviderPaymentInput
  ): Promise<CreateProviderPaymentResult>;

  getPaymentStatus(
    input: GetProviderPaymentStatusInput
  ): Promise<GetProviderPaymentStatusResult>;

  // Tradução de evento bruto do provider para estado JULLY (seção 9 da Etapa
  // 16). Dezenas de estados de provider mapeiam-se para no máximo
  // PENDING/PAID/FAILED/CANCELLED; null = ruído para o domínio (ignorado e
  // registrado). Um adapter real implementa isto com connaissance do provider.
  mapWebhookEventType?(eventType: string): PaymentStatus | null;
}

// ---------------------------------------------------------------------------
// Classificação de erros do provider (seção 18).
//
//   Definitivo  -> a operação NÃO ocorreu / foi recusada sem ambiguidade
//                  (ex.: cartão recusado, método inválido).
//                  Resultado no domínio: Payment FAILED.
//
//   Ambíguo     -> não sabemos se a operação ocorreu (timeout, connection
//                  reset, 5xx após a submissão do request, rota perdida).
//                  NUNCA vira FAILED automaticamente: Payment permanece
//                  PENDING e fica para reconciliação posterior — marcar FAILED
//                  no timeout poderia registrar dinheiro pago fora do sistema.
// ---------------------------------------------------------------------------
export class ProviderAmbiguousError extends Error {
  readonly failureCode: string | undefined;

  constructor(message: string, failureCode?: string) {
    super(message);
    this.name = "ProviderAmbiguousError";
    this.failureCode = failureCode;
  }
}

export class ProviderDefinitiveError extends Error {
  readonly failureCode: string | undefined;

  constructor(message: string, failureCode?: string) {
    super(message);
    this.name = "ProviderDefinitiveError";
    this.failureCode = failureCode;
  }
}
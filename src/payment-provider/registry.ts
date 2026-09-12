import { PaymentStatus } from "@/generated/prisma/client";
import {
  FAKE_PROVIDER_NAME,
  FakePaymentProvider,
} from "@/payment-provider/fake-provider";
import type { PaymentProvider } from "@/payment-provider/types";

// ---------- Provider Registry (Etapa 16, seção 21) ----------
//
// Resolução simples por mapa — nenhum framework de DI, nenhuma biblioteca.
// O FakePaymentProvider só é resolvível fora de produção (teste/dev
// controlado): em produção um PAYMENT_PROVIDER=fake retorna sem provider e a
// rota responde 503 PROVIDER_UNAVAILABLE (aplicação nunca vira "fake" em prod).

function providerAllowedInRuntime(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function getPaymentProvider(name: string): PaymentProvider | null {
  switch (name) {
    case FAKE_PROVIDER_NAME: {
      if (!providerAllowedInRuntime()) {
        return null;
      }
      return new FakePaymentProvider();
    }
    default:
      // Adapters reais (Mercado Pago, Stripe, ...) serão registrados aqui em
      // etapa futura, atrás de PAYMENT_PROVIDER. Nenhum SDK instalado agora.
      return null;
  }
}

export type WebhookEventTypeMapper = (eventType: string) => PaymentStatus | null;

// Mapeador de evento bruto do provider (adapter mapping, seção 9). Resolvido
// pelo nome do provider informado no evento do webhook.
export function getWebhookEventMapper(
  name: string
): WebhookEventTypeMapper | null {
  const provider = getPaymentProvider(name);
  if (!provider) {
    return null;
  }
  return provider.mapWebhookEventType ?? null;
}

export type RuntimeProviderResolution =
  | { provider: PaymentProvider }
  | { provider: null };

// Provider executável no runtime atual. Em dev/teste sem PAYMENT_PROVIDER
// explícito assume "fake"; em produção qualquer valor sem registro real
// retorna null (rota -> 503).
export function resolveRuntimePaymentProvider(): RuntimeProviderResolution {
  const name = (process.env.PAYMENT_PROVIDER ?? FAKE_PROVIDER_NAME)
    .trim()
    .toLowerCase();
  if (!name) {
    return { provider: null };
  }
  const provider = getPaymentProvider(name);
  if (!provider) {
    return { provider: null };
  }
  return { provider };
}
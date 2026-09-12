/**
 * Modulo central de moeda do JULLY (Etapa 15).
 *
 * Fonte de verdade para:
 *   - moedas reconhecidas (codigo ISO 4217 uppercase — nunca simbolo);
 *   - minor units de cada moeda;
 *   - validacao centralizada (nenhuma string arbitraria passa);
*  - formatacao quando necessaria (Intl.NumberFormat, sem simbolo manual).
 *
 * Escopo inicial: BRL, USD, EUR, GBP, JPY. Adicionar uma moeda nova nao
 * exige migration de schema (o banco armazena codigo como TEXT), apenas
 * acrescentar o registro aqui.
 *
 * IMPORTANTE: reconhecer uma moeda aqui NAO significa suporte comercial/
 * global completo. Cada moeda reconhecida precisa de revisao de politica
 * operacional antes de ser oferecida.
 *
 * CLIENT-SAFE: este modulo roda no browser (cart, painel) e, portanto, nunca
 * importa o Prisma Client em runtime.
 */

export const SUPPORTED_CURRENCIES = ["BRL", "USD", "EUR", "GBP", "JPY"] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

// Locale de apresentacao por moeda (usado apenas por Intl.NumberFormat).
const CURRENCY_FORMAT_LOCALE: Record<CurrencyCode, string> = {
  BRL: "pt-BR",
  USD: "en-US",
  EUR: "de-DE",
  GBP: "en-GB",
  JPY: "ja-JP",
};

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(
    value.trim().toUpperCase()
  );
}

// Normaliza e valida; lanca em moeda nao suportada ou formato invalido.
// O domínio nunca deve aceitar moeda fornecida pelo cliente sem passar aqui.
export function assertSupportedCurrency(value: string): CurrencyCode {
  const normalized = value.trim().toUpperCase();
  if (!isSupportedCurrency(normalized)) {
    throw new Error(`Unsupported currency code: ${JSON.stringify(value)}`);
  }
  return normalized;
}

// Quantidade de casas decimais (minor units) da moeda. NUNCA assumir 2.
export function minorUnitsFor(currency: CurrencyCode): number {
  const UNITS: Record<CurrencyCode, number> = {
    BRL: 2,
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
  };
  return UNITS[currency];
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: CurrencyCode): Intl.NumberFormat {
  let formatter = formatterCache.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(CURRENCY_FORMAT_LOCALE[currency], {
      style: "currency",
      currency,
      currencyDisplay: "symbol",
    });
    formatterCache.set(currency, formatter);
  }
  return formatter;
}

// Formata um decimal exato em STRING (ex.: "120.98") como moeda
// ("R$ 120,98", "US$ 120.98", "€ 120,98", "£120.98", "￥1,500").
// Usa Intl.NumberFormat e o codigo ISO da moeda — nunca simbolo manual.
//
// APRESENTACAO APENAS: valores vindos do servidor tem no maximo 2 casas
// decimais (DECIMAL(10,2) / toFixed(2)); o Number() aqui e so para exibicao,
// nunca para calculo monetario. Este modulo NAO pode importar o Prisma Client
// em runtime (components client nao podem puxar modulos node).
export function formatCurrencyDecimal(value: string, currency: string): string {
  const normalized = assertSupportedCurrency(currency);
  return formatterFor(normalized).format(Number(value));
}

// Variante para o carrinho publico (que trabalha com "centavos" — major units
// x 100). Compativel com as moedas iniciais: BASES de 2 minor units (BRL/USD/
// EUR/GBP) e JPY (inteiro), onde o valor real = cents/100.
export function formatCurrencyCents(cents: number, currency: string): string {
  const normalized = assertSupportedCurrency(currency);
  return formatterFor(normalized).format(cents / 100);
}
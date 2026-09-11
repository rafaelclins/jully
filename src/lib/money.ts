/**
 * Money handling for the public client.
 *
 * Prices travel as decimal strings (e.g. "24.90"). To avoid floating point
 * drift, all arithmetic uses integer cents. The frontend subtotal is only a
 * UX convenience: the future Order flow recalcules prices on the backend
 * from the current Product, which remains the source of truth.
 */

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function priceStringToCents(value: string): number {
  const trimmed = value.trim();
  const [intPart = "0", decPart = ""] = trimmed.split(".");
  const negative = intPart.startsWith("-");
  const digits = intPart.replace(/-/g, "").replace(/[^\d]/g, "");
  const reais = digits === "" ? 0 : Number(digits);
  const decNormalized = decPart.padEnd(2, "0").slice(0, 2);
  const centavos = decNormalized === "" ? 0 : Number(decNormalized);
  const cents = reais * 100 + centavos;
  return negative ? -cents : cents;
}

export function formatMoneyCents(cents: number): string {
  return brlFormatter.format(cents / 100);
}

// Formata uma string decimal exata (ex.: "59.70") como moeda pt-BR
// ("R$ 59,70") usando apenas manipulacao de string — sem Float.
export function formatBrzDecimal(value: string): string {
  const normalized = value.trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [intPart = "0", decPart = "0"] = unsigned.split(".");
  const centavos = decPart.padEnd(2, "0").slice(0, 2);
  const groupedInt = intPart
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".")
    .replace(/^\./, "");
  return `${negative ? "-" : ""}R$ ${groupedInt},${centavos}`;
}
import type { Prisma } from "@/generated/prisma/client";
import { formatCurrencyDecimal } from "@/lib/money/currency";

// Formata um Decimal exato como moeda do restaurante (iso 4217). NUNCA usa
// símbolo manual; a apresentação fica a cargo de Intl.NumberFormat.
export function formatPrice(
  value: Prisma.Decimal,
  currency: string
): string {
  return formatCurrencyDecimal(value.toFixed(2), currency);
}
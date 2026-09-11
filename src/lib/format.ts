import type { Prisma } from "@/generated/prisma/client";

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function formatPrice(value: Prisma.Decimal): string {
  return brlFormatter.format(value.toNumber());
}
"use client";

import { useCart } from "@/components/cart/cart-provider";
import type { CartLine } from "@/components/cart/cart-state";
import { formatCurrencyCents } from "@/lib/money/currency";

type CartItemProps = {
  line: CartLine;
};

export function CartItem({ line }: CartItemProps) {
  const { incrementItem, decrementItem, removeItem, currency } = useCart();

  const lineSubtotalCents = line.unitPriceCents * line.quantity;

  return (
    <li className="py-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-zinc-900">
          {line.name}
        </h2>
        <p className="shrink-0 text-sm font-bold text-zinc-900">
          {formatCurrencyCents(lineSubtotalCents, currency)}
        </p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="inline-flex items-center rounded-full border border-zinc-200">
          <button
            type="button"
            onClick={() => decrementItem(line.productId)}
            aria-label={`Diminuir a quantidade de ${line.name}`}
            className="flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 active:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            −
          </button>
          <span
            aria-live="polite"
            className="w-10 text-center text-sm font-semibold tabular-nums text-zinc-900"
          >
            {line.quantity}
          </span>
          <button
            type="button"
            onClick={() => incrementItem(line.productId)}
            aria-label={`Aumentar a quantidade de ${line.name}`}
            className="flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 active:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            +
          </button>
        </div>
        <button
          type="button"
          onClick={() => removeItem(line.productId)}
          className="rounded-full px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 active:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
        >
          Remover
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {formatCurrencyCents(line.unitPriceCents, currency)} por unidade
      </p>
    </li>
  );
}
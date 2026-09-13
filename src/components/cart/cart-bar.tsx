"use client";

import { useCart } from "@/components/cart/cart-provider";
import { formatCurrencyCents } from "@/lib/money/currency";

export function CartBar() {
  const { items, totalItems, subtotalCents, currency, openCart } = useCart();

  if (items.length === 0) {
    return null;
  }

  const itemLabel = totalItems === 1 ? "item" : "itens";

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="mx-auto flex w-full max-w-md items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-zinc-500">
            Carrinho · {totalItems} {itemLabel}
          </p>
          <p className="text-lg font-bold leading-snug text-zinc-900">
            Subtotal {formatCurrencyCents(subtotalCents, currency)}
          </p>
        </div>
        <button
          type="button"
          onClick={openCart}
          className="shrink-0 rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          Ver carrinho
        </button>
      </div>
    </div>
  );
}

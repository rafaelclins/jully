"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

import { CartItem } from "@/components/cart/cart-item";
import { useCart } from "@/components/cart/cart-provider";
import { formatMoneyCents } from "@/lib/money";

export function CartView() {
  const { items, totalItems, subtotalCents, isCartOpen, closeCart } = useCart();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isCartOpen) {
      closeButtonRef.current?.focus();
    }
  }, [isCartOpen]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCart();
      }
    },
    [closeCart]
  );

  if (!isCartOpen) {
    return null;
  }

  const itemLabel = totalItems === 1 ? "item" : "itens";

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        onClick={closeCart}
        className="absolute inset-0 cursor-pointer bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Carrinho"
        onKeyDown={handleKeyDown}
        className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
          <h1 className="text-lg font-bold tracking-tight text-zinc-900">
            Carrinho
          </h1>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeCart}
            aria-label="Fechar carrinho"
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 active:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {items.length === 0 ? (
            <p className="py-12 text-center text-sm leading-relaxed text-zinc-500">
              Seu carrinho está vazio.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-zinc-100">
                {items.map((line) => (
                  <CartItem key={line.productId} line={line} />
                ))}
              </ul>
              <div className="mt-2 flex items-baseline justify-between border-t border-zinc-200 py-4">
                <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                  Total · {totalItems} {itemLabel}
                </p>
                <p className="text-xl font-bold text-zinc-900">
                  {formatMoneyCents(subtotalCents)}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
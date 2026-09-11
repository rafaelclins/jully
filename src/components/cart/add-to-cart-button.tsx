"use client";

import type { AddToCartProduct } from "@/components/cart/cart-state";
import { useCart } from "@/components/cart/cart-provider";

type AddToCartButtonProps = {
  product: AddToCartProduct;
};

export function AddToCartButton({ product }: AddToCartButtonProps) {
  const { addItem } = useCart();

  return (
    <button
      type="button"
      onClick={() => addItem(product)}
      className="shrink-0 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
    >
      Adicionar
    </button>
  );
}
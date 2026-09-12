"use client";

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import {
  CART_INITIAL_STATE,
  cartReducer,
  getCartLines,
  getSubtotalCents,
  getTotalItems,
  type AddToCartProduct,
  type CartLine,
} from "@/components/cart/cart-state";

type CartContextValue = {
  items: CartLine[];
  totalItems: number;
  subtotalCents: number;
  currency: string;
  isCartOpen: boolean;
  addItem: (product: AddToCartProduct) => void;
  incrementItem: (productId: string) => void;
  decrementItem: (productId: string) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
  openCart: () => void;
  closeCart: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

type CartProviderProps = {
  contextId: string;
  currency: string;
  children: ReactNode;
};

export function CartProvider({
  contextId,
  currency,
  children,
}: CartProviderProps) {
  const [state, dispatch] = useReducer(cartReducer, CART_INITIAL_STATE);

  const value = useMemo<CartContextValue>(() => {
    const lines = getCartLines(state, contextId);
    return {
      items: lines,
      totalItems: getTotalItems(lines),
      subtotalCents: getSubtotalCents(lines),
      currency,
      isCartOpen: state.isOpen,
      addItem: (product: AddToCartProduct) =>
        dispatch({ type: "ADD_ITEM", contextId, product }),
      incrementItem: (productId: string) =>
        dispatch({ type: "INCREMENT_ITEM", contextId, productId }),
      decrementItem: (productId: string) =>
        dispatch({ type: "DECREMENT_ITEM", contextId, productId }),
      removeItem: (productId: string) =>
        dispatch({ type: "REMOVE_ITEM", contextId, productId }),
      clearCart: () => dispatch({ type: "CLEAR_CART", contextId }),
      openCart: () => dispatch({ type: "OPEN_CART" }),
      closeCart: () => dispatch({ type: "CLOSE_CART" }),
    };
  }, [state, contextId, currency]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error("useCart deve ser usado dentro de <CartProvider>");
  }
  return ctx;
}
export type CartLine = {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
};

export type AddToCartProduct = {
  id: string;
  name: string;
  unitPriceCents: number;
};

export type CartContextId = string;

export type CartState = {
  carts: Record<CartContextId, Record<string, CartLine>>;
  isOpen: boolean;
};

export type CartAction =
  | { type: "ADD_ITEM"; contextId: CartContextId; product: AddToCartProduct }
  | { type: "INCREMENT_ITEM"; contextId: CartContextId; productId: string }
  | { type: "DECREMENT_ITEM"; contextId: CartContextId; productId: string }
  | { type: "REMOVE_ITEM"; contextId: CartContextId; productId: string }
  | { type: "OPEN_CART" }
  | { type: "CLOSE_CART" };

export const MAX_ITEM_QUANTITY = 99;

export const CART_INITIAL_STATE: CartState = {
  carts: {},
  isOpen: false,
};

function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const quantity = Math.trunc(value);
  if (quantity <= 0) return 1;
  return Math.min(quantity, MAX_ITEM_QUANTITY);
}

export function cartReducer(
  state: CartState,
  action: CartAction
): CartState {
  switch (action.type) {
    case "ADD_ITEM": {
      const cart = state.carts[action.contextId] ?? {};
      const existing = cart[action.product.id];
      const quantity = existing
        ? clampQuantity(existing.quantity + 1)
        : 1;
      return {
        ...state,
        carts: {
          ...state.carts,
          [action.contextId]: {
            ...cart,
            [action.product.id]: {
              productId: action.product.id,
              name: action.product.name,
              unitPriceCents: action.product.unitPriceCents,
              quantity,
            },
          },
        },
      };
    }
    case "INCREMENT_ITEM": {
      const cart = state.carts[action.contextId] ?? {};
      const existing = cart[action.productId];
      if (!existing) return state;
      return {
        ...state,
        carts: {
          ...state.carts,
          [action.contextId]: {
            ...cart,
            [action.productId]: {
              ...existing,
              quantity: clampQuantity(existing.quantity + 1),
            },
          },
        },
      };
    }
    case "DECREMENT_ITEM": {
      const cart = state.carts[action.contextId] ?? {};
      const existing = cart[action.productId];
      if (!existing) return state;
      const nextCart = { ...cart };
      if (existing.quantity <= 1) {
        delete nextCart[action.productId];
      } else {
        nextCart[action.productId] = {
          ...existing,
          quantity: existing.quantity - 1,
        };
      }
      return { ...state, carts: { ...state.carts, [action.contextId]: nextCart } };
    }
    case "REMOVE_ITEM": {
      const cart = state.carts[action.contextId] ?? {};
      if (!cart[action.productId]) return state;
      const nextCart = { ...cart };
      delete nextCart[action.productId];
      return { ...state, carts: { ...state.carts, [action.contextId]: nextCart } };
    }
    case "OPEN_CART":
      return { ...state, isOpen: true };
    case "CLOSE_CART":
      return { ...state, isOpen: false };
  }
}

export function getCartLines(
  state: CartState,
  contextId: CartContextId
): CartLine[] {
  return Object.values(state.carts[contextId] ?? {});
}

export function getTotalItems(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function getSubtotalCents(lines: CartLine[]): number {
  return lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0
  );
}
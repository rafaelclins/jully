"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { CartItem } from "@/components/cart/cart-item";
import { useCart } from "@/components/cart/cart-provider";
import { formatCurrencyCents } from "@/lib/money/currency";

type Feedback =
  | { kind: "success" }
  | { kind: "error"; message: string };

type CartViewProps = {
  qrToken: string;
};

type PendingAttempt = { key: string; signature: string };

function friendlyErrorMessage(status: number, code?: string): string {
  if (code === "TABLE_NOT_FOUND" || status === 404) {
    return "Este QR Code não é válido.";
  }
  if (code === "TABLE_INACTIVE") {
    return "Esta mesa não está disponível no momento.";
  }
  if (code === "MENU_CHANGED") {
    return "O cardápio mudou. Revise seu carrinho e tente novamente.";
  }
  if (code === "IDEMPOTENCY_CONFLICT") {
    return "Não foi possível confirmar este envio. Tente novamente.";
  }
  if (code === "QUANTITY_OVER_LIMIT" || status === 400) {
    return "Não foi possível enviar o pedido. Revise os itens e tente novamente.";
  }
  return "Não foi possível enviar o pedido. Tente novamente em instantes.";
}

// Assinatura logica do carrinho: independente da ordem dos itens.
// Mudou o carrinho, mudou a assinatura, e a tentativa pendente e invalidada.
function cartSignature(items: { productId: string; quantity: number }[]): string {
  return items
    .map((item) => `${item.productId}:${item.quantity}`)
    .sort()
    .join("|");
}

function percentLabel(value: string): string {
  return value.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function serviceFeeCents(subtotalCents: number, serviceFeePercent: string): number {
  const percent = Number(serviceFeePercent);
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }
  return Math.round((subtotalCents * percent) / 100);
}

export function CartView({ qrToken }: CartViewProps) {
  const {
    items,
    totalItems,
    subtotalCents,
    serviceFeePercent,
    currency,
    isCartOpen,
    closeCart,
    clearCart,
  } = useCart();

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const submittingRef = useRef(false);
  const attemptRef = useRef<PendingAttempt | null>(null);
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

  const handleClose = useCallback(() => {
    setFeedback(null);
    setSubmitting(false);
    submittingRef.current = false;
    closeCart();
  }, [closeCart]);

  async function handleSubmit() {
    if (submittingRef.current || items.length === 0) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFeedback(null);

    const signature = cartSignature(items);
    let key: string;
    if (
      attemptRef.current &&
      attemptRef.current.signature === signature
    ) {
      key = attemptRef.current.key;
    } else {
      // Tentativa logica nova (ou carrinho alterado apos falha):
      // gera/renova a chave de idempotencia uma unica vez.
      key = crypto.randomUUID();
      attemptRef.current = { key, signature };
    }

    try {
      const response = await fetch(`/api/public/tables/${qrToken}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          items: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;

      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: friendlyErrorMessage(response.status, data?.code),
        });
        return;
      }

      // Sucesso confirmado (201 criado ou 200 replay): encerra a tentativa.
      attemptRef.current = null;
      clearCart();
      setFeedback({ kind: "success" });
    } catch {
      setFeedback({
        kind: "error",
        message: "Não foi possível enviar o pedido. Tente novamente em instantes.",
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!isCartOpen) {
    return null;
  }

  const itemLabel = totalItems === 1 ? "item" : "itens";
  const feeCents = serviceFeeCents(subtotalCents, serviceFeePercent);
  const estimatedTotalCents = subtotalCents + feeCents;
  const serviceFeeLabel = percentLabel(serviceFeePercent);

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        onClick={handleClose}
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
            onClick={handleClose}
            aria-label="Fechar carrinho"
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 active:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            ×
          </button>
        </div>

        <div
          aria-live="polite"
          className="overflow-y-auto px-5 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {feedback?.kind === "success" ? (
            <div className="py-12 text-center">
              <p className="text-lg font-bold text-zinc-900">
                Pedido enviado com sucesso.
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                Em breve, seu pedido será preparado.
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                Limpamos o carrinho para evitar reenvio do mesmo pedido.
              </p>
              <button
                type="button"
                onClick={handleClose}
                className="mt-6 rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
              >
                Voltar ao cardápio
              </button>
            </div>
          ) : feedback?.kind === "error" ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-semibold text-red-700">
                {feedback.message}
              </p>
            </div>
          ) : null}

          {items.length === 0 && feedback?.kind !== "success" ? (
            <p className="py-12 text-center text-sm leading-relaxed text-zinc-500">
              Seu carrinho está vazio.
            </p>
          ) : items.length > 0 ? (
            <>
              <ul className="divide-y divide-zinc-100">
                {items.map((line) => (
                  <CartItem key={line.productId} line={line} />
                ))}
              </ul>
              <div className="mt-2 border-t border-zinc-200 py-4">
                <dl className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-500">
                      Subtotal · {totalItems} {itemLabel}
                    </dt>
                    <dd className="font-semibold text-zinc-900">
                      {formatCurrencyCents(subtotalCents, currency)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-zinc-500">
                      Taxa de serviço {serviceFeeLabel}%
                    </dt>
                    <dd className="font-semibold text-zinc-900">
                      {formatCurrencyCents(feeCents, currency)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-zinc-200 pt-2">
                    <dt className="font-bold text-zinc-900">Total estimado</dt>
                    <dd className="text-xl font-bold text-zinc-900">
                      {formatCurrencyCents(estimatedTotalCents, currency)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                  A taxa é calculada no fechamento da mesa. Este total é uma estimativa.
                </p>
              </div>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || items.length === 0}
                className="w-full rounded-full bg-zinc-900 px-4 py-3.5 text-base font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Enviando…" : "Enviar pedido"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

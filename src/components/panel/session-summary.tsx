"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { formatCurrencyDecimal } from "@/lib/money/currency";
import type { SessionSummaryDto } from "@/services/sessions";

type SessionSummaryViewProps = {
  restaurantSlug: string;
  sessionId: string;
  initialSummary: SessionSummaryDto;
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente",
  PREPARING: "Em preparo",
  READY: "Pronto",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function percentLabel(value: string): string {
  return value.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export function SessionSummaryView({
  restaurantSlug,
  sessionId,
  initialSummary,
}: SessionSummaryViewProps) {
  const router = useRouter();
  const [summary, setSummary] = useState<SessionSummaryDto>(initialSummary);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  const goToLogin = useCallback(() => {
    router.replace("/login");
    router.refresh();
  }, [router]);

  const isClosed = summary.session.status === "CLOSED";
  const hasBlockingOrders = summary.orders.some(
    (order) => order.status === "PENDING" || order.status === "PREPARING"
  );
  const canClose = !isClosed && !hasBlockingOrders;

  async function reloadSummary() {
    const response = await fetch(
      `/api/restaurant/${restaurantSlug}/sessions/${sessionId}/summary`,
      { cache: "no-store" }
    );
    if (response.status === 401) {
      goToLogin();
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { summary: SessionSummaryDto };
    setSummary(data.summary);
    return data.summary;
  }

  async function handleClose() {
    if (busy || !canClose) {
      return;
    }
    setNotice(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/restaurant/${restaurantSlug}/sessions/${sessionId}/close`,
        { method: "POST" }
      );
      const data = (await response.json().catch(() => null)) as {
        code?: string;
        summary?: SessionSummaryDto;
      } | null;

      if (response.status === 401) {
        goToLogin();
        return;
      }
      if (response.status === 409) {
        setNotice({
          kind: "error",
          text:
            data?.code === "SESSION_HAS_ACTIVE_ORDERS"
              ? "Ainda existem pedidos em andamento."
              : "Não foi possível fechar a mesa. Tente novamente.",
        });
        await reloadSummary();
        return;
      }
      if (response.ok && data?.summary) {
        setSummary(data.summary);
        setNotice({ kind: "success", text: "Mesa fechada." });
        return;
      }
      setNotice({
        kind: "error",
        text: "Não foi possível fechar a mesa. Tente novamente.",
      });
    } catch {
      setNotice({
        kind: "error",
        text: "Não foi possível fechar a mesa. Tente novamente.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-zinc-100 pb-12">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6">
          <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
            JULLY
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">
            Mesa {summary.table.number}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {summary.restaurant.name}
          </p>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
        {isClosed ? (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
            Mesa fechada{summary.payment ? ` · ${summary.payment.status === "PAID" ? "paga" : "não paga"}` : ""}
          </div>
        ) : null}

        {notice ? (
          <div
            role="status"
            aria-live="polite"
            className={
              notice.kind === "error"
                ? "mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
                : "mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700"
            }
          >
            {notice.text}
          </div>
        ) : null}

        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-500">
              Pedidos
            </h2>
            <p className="text-sm text-zinc-500">
              Aberta em {dateTimeFormatter.format(new Date(summary.session.openedAt))}
            </p>
          </div>

          {summary.orders.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              Nenhum pedido nesta mesa.
            </p>
          ) : (
            <ol className="mt-4 space-y-5">
              {summary.orders.map((order, index) => (
                <li key={order.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-bold text-zinc-900">
                      Pedido {index + 1}
                      <span className="ml-2 font-semibold text-zinc-500">
                        {ORDER_STATUS_LABEL[order.status] ?? order.status}
                      </span>
                    </p>
                    <p className="text-lg font-bold text-zinc-900">
                      {formatCurrencyDecimal(order.subtotal, summary.currency)}
                    </p>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-zinc-700">
                    {order.items.map((item) => (
                      <li key={item.id} className="flex justify-between gap-3">
                        <span className="min-w-0">
                          <span className="font-semibold text-zinc-900">
                            {item.quantity}×{" "}
                          </span>
                          {item.productName}
                        </span>
                        <span className="shrink-0 text-zinc-500">
                          {formatCurrencyDecimal(item.subtotal, summary.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">Subtotal</dt>
              <dd className="font-semibold text-zinc-900">
                {formatCurrencyDecimal(summary.subtotal, summary.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-zinc-500">
                Taxa de serviço {percentLabel(summary.serviceFeePercent)}%
              </dt>
              <dd className="font-semibold text-zinc-900">
                {formatCurrencyDecimal(summary.serviceFeeAmount, summary.currency)}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-zinc-200 pt-2">
              <dt className="text-base font-bold text-zinc-900">Total</dt>
              <dd className="text-xl font-bold text-zinc-900">
                {formatCurrencyDecimal(summary.total, summary.currency)}
              </dd>
            </div>
          </dl>

          <div className="mt-5">
            {isClosed ? null : hasBlockingOrders ? (
              <>
                <p
                  role="status"
                  className="mb-3 text-sm font-semibold text-amber-700"
                >
                  Ainda existem pedidos em andamento.
                </p>
                <button
                  type="button"
                  disabled
                  className="w-full rounded-full bg-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-500 disabled:cursor-not-allowed"
                >
                  Fechar mesa
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleClose()}
                disabled={busy}
                className="w-full rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? "Fechando…" : "Fechar mesa"}
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
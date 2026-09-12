"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { authClient } from "@/lib/auth-client";
import { formatBrzDecimal } from "@/lib/money";

type PanelOrder = {
  id: string;
  status: "PENDING" | "PREPARING" | "READY";
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  tableNumber: number;
  items: {
    id: string;
    productName: string;
    unitPrice: string;
    quantity: number;
    subtotal: string;
  }[];
  total: string;
};

const POLL_INTERVAL_MS = 5000;

const STATUS_LABEL: Record<PanelOrder["status"], string> = {
  PENDING: "Pendente",
  PREPARING: "Em preparo",
  READY: "Pronto",
};

const timeFormatter = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

function transitionMessage(code?: string): string {
  switch (code) {
    case "ORDER_STATUS_CONFLICT":
      return "Este pedido foi atualizado por outra tela. A lista foi recarregada.";
    case "INVALID_STATUS_TRANSITION":
      return "Não é possível fazer essa mudança de status.";
    case "SESSION_CLOSED":
      return "A mesa já foi fechada. Nenhum pedido pode mais mudar de status.";
    case "ORDER_NOT_FOUND":
      return "Pedido não encontrado.";
    default:
      return "Não foi possível atualizar o pedido. Tente novamente.";
  }
}

function nextTransition(order: PanelOrder): {
  target: PanelOrder["status"];
  label: string;
} | null {
  if (order.status === "PENDING") {
    return { target: "PREPARING", label: "Iniciar preparo" };
  }
  if (order.status === "PREPARING") {
    return { target: "READY", label: "Marcar como pronto" };
  }
  return null;
}

type OrdersPanelProps = {
  restaurantSlug: string;
  restaurantName: string;
};

export function OrdersPanel({
  restaurantSlug,
  restaurantName,
}: OrdersPanelProps) {
  const router = useRouter();
  const [orders, setOrders] = useState<PanelOrder[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [pollError, setPollError] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [busyOrderIds, setBusyOrderIds] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const loadingRef = useRef(false);

  const goToLogin = useCallback(() => {
  router.replace("/login");
  router.refresh();
}, [router]);

const loadOrders = useCallback(async () => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setRefreshing(true);
    try {
      const response = await fetch(
        `/api/restaurant/${restaurantSlug}/orders`,
        { cache: "no-store" }
      );
      if (response.status === 401) {
        // Sessao expirada/invalida: volta para o login.
        goToLogin();
        return;
      }
      if (!response.ok) {
        throw new Error(`list failed with ${response.status}`);
      }
      const data = (await response.json()) as { orders: PanelOrder[] };
      setOrders(data.orders);
      setLastUpdatedAt(new Date());
      setPollError(false);
      setPhase("ready");
    } catch {
      // Erro temporario: mantém os pedidos ja exibidos intactos.
      setPollError(true);
      setPhase("ready");
    } finally {
      loadingRef.current = false;
      setRefreshing(false);
    }
  }, [restaurantSlug, goToLogin]);

  useEffect(() => {
    // Primeira carga + polling leve (~5s) apenas enquanto o painel esta aberto.
    // Carregamento e atualizacoes nao se sobrepoem (loadingRef).
    const schedule = () => void loadOrders();
    const firstTick = window.setTimeout(schedule, 0);
    const timer = window.setInterval(schedule, POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(firstTick);
      window.clearInterval(timer);
    };
  }, [loadOrders]);

  async function advanceStatus(order: PanelOrder) {
    const transition = nextTransition(order);
    if (!transition || busyOrderIds.has(order.id)) {
      return;
    }
    setMessage(null);
    setBusyOrderIds((prev) => new Set(prev).add(order.id));
    try {
      const response = await fetch(
        `/api/restaurant/${restaurantSlug}/orders/${order.id}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: transition.target }),
        }
      );
      const data = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;

      if (response.status === 401) {
        goToLogin();
        return;
      }

      await loadOrders();

      if (!response.ok) {
        setMessage({
          kind: "error",
          text: transitionMessage(data?.code),
        });
      }
    } catch {
      await loadOrders();
      setMessage({
        kind: "error",
        text: "Não foi possível atualizar o pedido. Tente novamente.",
      });
    } finally {
      setBusyOrderIds((prev) => {
        const next = new Set(prev);
        next.delete(order.id);
        return next;
      });
    }
  }

  const sections: {
    status: PanelOrder["status"];
    title: string;
  }[] = [
    { status: "PENDING", title: "Pendentes" },
    { status: "PREPARING", title: "Em preparo" },
    { status: "READY", title: "Prontos" },
  ];

  const anyOrders = orders.length > 0;

  async function handleSignOut() {
    try {
      await authClient.signOut();
    } finally {
      goToLogin();
    }
  }

  return (
    <main className="min-h-dvh bg-zinc-100">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
                JULLY
              </p>
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900">
                {restaurantName}
              </h1>
            </div>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              Sair
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void loadOrders()}
              className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              {refreshing ? "Atualizando…" : "Atualizar"}
            </button>
            <p
              aria-live="polite"
              className="text-sm text-zinc-500"
            >
              {lastUpdatedAt
                ? `Atualizado às ${timeFormatter.format(lastUpdatedAt)}`
                : "Carregando pedidos…"}
            </p>
            {pollError ? (
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-amber-700"
              >
                Não foi possível atualizar. Mantendo a última atualização.
              </p>
            ) : null}
          </div>
        </div>
      </header>

      {message ? (
        <div
          role="status"
          aria-live="polite"
          className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6"
        >
          <p
            className={
              message.kind === "error"
                ? "rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
                : "rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700"
            }
          >
            {message.text}
          </p>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <h2 className="sr-only">Pedidos</h2>

        {phase === "loading" ? (
          <p className="py-10 text-center text-sm text-zinc-500">
            Carregando pedidos…
          </p>
        ) : !anyOrders ? (
          <p className="py-10 text-center text-sm text-zinc-500">
            Nenhum pedido ativo no momento.
          </p>
        ) : (
          <div className="space-y-8">
            {sections.map((section) => {
              const sectionOrders = orders.filter(
                (order) => order.status === section.status
              );
              if (sectionOrders.length === 0) {
                return null;
              }
              return (
                <section key={section.status} aria-label={section.title}>
                  <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-zinc-500">
                    {section.title}
                  </h3>
                  <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {sectionOrders.map((order) => (
                      <li key={order.id}>
                        <OrderCard
                          order={order}
                          restaurantSlug={restaurantSlug}
                          busy={busyOrderIds.has(order.id)}
                          onAdvance={() => void advanceStatus(order)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function OrderCard({
  order,
  restaurantSlug,
  busy,
  onAdvance,
}: {
  order: PanelOrder;
  restaurantSlug: string;
  busy: boolean;
  onAdvance: () => void;
}) {
  const transition = nextTransition(order);
  const statusLabel = STATUS_LABEL[order.status];

  return (
    <article className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-bold leading-tight text-zinc-900">
            Mesa {order.tableNumber}
          </p>
          <p className="text-sm text-zinc-500">
            Pedido às {formatTime(order.createdAt)}
          </p>
        </div>
        <span
          className={
            order.status === "PENDING"
              ? "rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700"
              : order.status === "PREPARING"
                ? "rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700"
                : "rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
          }
        >
          {statusLabel}
        </span>
      </div>

      <ul className="mt-4 space-y-1.5 text-sm text-zinc-700">
        {order.items.map((item) => (
          <li key={item.id}>
            <span className="font-semibold text-zinc-900">
              {item.quantity}×{" "}
            </span>
            {item.productName}
            <span className="text-zinc-500"> · {formatBrzDecimal(item.subtotal)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-4">
        <div className="border-t border-zinc-200 pt-3">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Total
            </p>
            <p className="text-lg font-bold text-zinc-900">
              {formatBrzDecimal(order.total)}
            </p>
          </div>
        </div>

        {transition ? (
          <button
            type="button"
            onClick={onAdvance}
            disabled={busy}
            className="mt-3 w-full rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Atualizando…" : transition.label}
          </button>
        ) : null}

        <Link
          href={`/restaurant/${restaurantSlug}/sessions/${order.sessionId}`}
          className="mt-2 block w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-center text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
        >
          Ver conta da mesa
        </Link>
      </div>
    </article>
  );
}
import { createHash } from "node:crypto";

import { OrderStatus, Prisma, SessionStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateOpenSessionForTableWithClient } from "@/services/sessions";
import { getTableByQrToken } from "@/services/tables";

export const MAX_ORDER_ITEM_QUANTITY = 99;

export const OPERATIONAL_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PREPARING,
  OrderStatus.READY,
] as const;

// A maquina de estados da Etapa 10: somente avancos simples.
export const ALLOWED_ORDER_TRANSITIONS: Record<
  OrderStatus,
  readonly OrderStatus[]
> = {
  PENDING: [OrderStatus.PREPARING],
  PREPARING: [OrderStatus.READY],
  READY: [],
  CANCELLED: [],
};

export const OPERATIONAL_ORDER_STATUS_LIST: OrderStatus[] = [
  ...OPERATIONAL_ORDER_STATUSES,
];

export type CreateOrderInputItem = {
  productId: string;
  quantity: number;
};

export type CreatedOrderDto = {
  id: string;
  status: string;
  createdAt: Date;
  items: {
    productId: string;
    productName: string;
    unitPrice: string;
    quantity: number;
    subtotal: string;
  }[];
  subtotal: string;
};

export type CreateOrderResult =
  | { outcome: "created"; order: CreatedOrderDto }
  | { outcome: "replayed"; order: CreatedOrderDto }
  | { outcome: "idempotency-conflict" }
  | { outcome: "table-not-found" }
  | { outcome: "table-inactive" }
  | { outcome: "menu-changed" }
  | { outcome: "quantity-over-limit" };

function normalizeQuantities(
  items: CreateOrderInputItem[]
):
  | { ok: true; entries: CreateOrderInputItem[] }
  | { ok: false } {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const total = (quantities.get(item.productId) ?? 0) + item.quantity;
    if (total > MAX_ORDER_ITEM_QUANTITY) {
      return { ok: false };
    }
    quantities.set(item.productId, total);
  }
  return {
    ok: true,
    entries: [...quantities.entries()].map(([productId, quantity]) => ({
      productId,
      quantity,
    })),
  };
}

export function computeRequestFingerprint(
  entries: CreateOrderInputItem[]
): string {
  const canonical = [...entries]
    .sort((a, b) =>
      a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0
    )
    .map((entry) => `${entry.productId}:${entry.quantity}`)
    .join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const orderPublicSelect = {
  id: true,
  sessionId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrderSelect;

export type OrderPublic = Prisma.OrderGetPayload<{
  select: typeof orderPublicSelect;
}>;

const orderItemPublicSelect = {
  id: true,
  productId: true,
  productName: true,
  unitPrice: true,
  quantity: true,
  subtotal: true,
} satisfies Prisma.OrderItemSelect;

export const orderWithItemsSelect = {
  ...orderPublicSelect,
  items: { select: orderItemPublicSelect },
} satisfies Prisma.OrderSelect;

export type OrderWithItems = Prisma.OrderGetPayload<{
  select: typeof orderWithItemsSelect;
}>;

export async function getOrderById({
  restaurantId,
  orderId,
}: {
  restaurantId: string;
  orderId: string;
}): Promise<OrderWithItems | null> {
  return prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: orderWithItemsSelect,
  });
}

export async function listOrdersBySessionId({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<OrderWithItems[]> {
  return prisma.order.findMany({
    where: { sessionId, restaurantId },
    select: orderWithItemsSelect,
    orderBy: { createdAt: "asc" },
  });
}

const orderForReplaySelect = {
  ...orderWithItemsSelect,
  requestFingerprint: true,
} satisfies Prisma.OrderSelect;

function toCreatedOrderDto(order: OrderWithItems): CreatedOrderDto {
  const subtotal = order.items.reduce(
    (acc, item) => acc.add(item.subtotal),
    new Prisma.Decimal(0)
  );
  return {
    id: order.id,
    status: order.status,
    createdAt: order.createdAt,
    items: order.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      unitPrice: item.unitPrice.toFixed(2),
      quantity: item.quantity,
      subtotal: item.subtotal.toFixed(2),
    })),
    subtotal: subtotal.toFixed(2),
  };
}

// Criacao de pedido e fechamento de mesa compartilham o MESMO protocolo de
// serializacao por mesa: lock na linha da Tabela (SELECT ... FOR UPDATE)
// dentro da transacao. Toda a resolucao/criacao de Session e de Order acontece
// DENTRO dessa regiao, e o estado da Session e relido depois do lock.
//
// Assim, se o fechamento venceu (Session ja CLOSED), a criacao serializada a
// pos encontra apenas Sessions OPEN -> resolve/cria uma NOVA Session, e o
// Order nunca pertence a Session CLOSED. Se a criacao vence, o close relido
// apos o lock ve o PENDING/PREPARING e responde 409 (invariante preservada).
//
// Idempotencia: a checagem de replay fica na mesma regiao serializada, entao
// dois envios com a mesma Idempotency-Key na mesma mesa serializam e o segundo
// relê o Order commitado (sem P2002 na borda). A chave continua escopada por
// TableSession: um retry apos fechamento cai numa Session nova.
export async function createOrderForTableQrToken(
  qrToken: string,
  idempotencyKey: string,
  items: CreateOrderInputItem[]
): Promise<CreateOrderResult> {
  const table = await getTableByQrToken(qrToken);
  if (!table) {
    return { outcome: "table-not-found" };
  }
  if (!table.active) {
    return { outcome: "table-inactive" };
  }

  const restaurantId = table.restaurant.id;

  const normalized = normalizeQuantities(items);
  if (!normalized.ok) {
    return { outcome: "quantity-over-limit" };
  }

  const fingerprint = computeRequestFingerprint(normalized.entries);
  const productIds = normalized.entries.map((entry) => entry.productId);

  const result = await prisma.$transaction(async (tx) => {
    // Regiao de serializacao compartilhada com o fechamento de mesa.
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT "id" FROM "tables"
        WHERE "id" = ${table.id}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
        FOR UPDATE
      `
    );
    if (locked.length === 0) {
      return { outcome: "table-not-found" } as const;
    }

    // Resolucao da Session dentro da regiao serializada: revalida se ainda
    // existe Session OPEN (nunca reutiliza sessionId lido antes do lock).
    const { session } = await getOrCreateOpenSessionForTableWithClient(tx, {
      restaurantId,
      tableId: table.id,
    });

    const existing = await tx.order.findFirst({
      where: { sessionId: session.id, idempotencyKey, restaurantId },
      select: orderForReplaySelect,
    });
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        return { outcome: "idempotency-conflict" } as const;
      }
      return { outcome: "replayed", order: existing } as const;
    }

    const products = await tx.product.findMany({
      where: { id: { in: productIds }, restaurantId, active: true },
    });
    if (products.length !== productIds.length) {
      return { outcome: "menu-changed" } as const;
    }
    const productsById = new Map(
      products.map((product) => [product.id, product])
    );

    const order = await tx.order.create({
      data: {
        sessionId: session.id,
        restaurantId,
        idempotencyKey,
        requestFingerprint: fingerprint,
      },
      select: { id: true },
    });

    await tx.orderItem.createMany({
      data: normalized.entries.map((entry) => {
        const product = productsById.get(entry.productId);
        if (!product) {
          throw new Error(
            `Product ${entry.productId} resolved but missing after lookup`
          );
        }
        return {
          orderId: order.id,
          productId: product.id,
          restaurantId,
          productName: product.name,
          unitPrice: product.price,
          quantity: entry.quantity,
          subtotal: product.price.mul(entry.quantity),
        };
      }),
    });

    return { outcome: "created", orderId: order.id } as const;
  });

  if (result.outcome === "table-not-found") {
    return { outcome: "table-not-found" };
  }
  if (result.outcome === "menu-changed") {
    return { outcome: "menu-changed" };
  }
  if (result.outcome === "idempotency-conflict") {
    return { outcome: "idempotency-conflict" };
  }
  if (result.outcome === "replayed") {
    return { outcome: "replayed", order: toCreatedOrderDto(result.order) };
  }

  const full = await prisma.order.findFirst({
    where: { id: result.orderId, restaurantId },
    select: orderWithItemsSelect,
  });
  if (!full) {
    throw new Error("Created order not found for DTO");
  }
  return { outcome: "created", order: toCreatedOrderDto(full) };
}

const operationalOrderListSelect = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  sessionId: true,
  session: {
    select: {
      table: {
        select: { number: true },
      },
    },
  },
  items: {
    select: {
      id: true,
      productName: true,
      unitPrice: true,
      quantity: true,
      subtotal: true,
    },
    orderBy: { productName: "asc" },
  },
} satisfies Prisma.OrderSelect;

type OperationalOrderRow = Prisma.OrderGetPayload<{
  select: typeof operationalOrderListSelect;
}>;

export type OperationalOrderDto = {
  id: string;
  status: string;
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
  // Moeda operacional do restaurante (orders operacionais estão em Sessions
  // OPEN; a moeda da conta fechada vem de currencySnapshot).
  currency: string;
};

function toOperationalOrderDto(
  order: OperationalOrderRow,
  currency: string
): OperationalOrderDto {
  // Total sempre calculado a partir dos snapshots (OrderItem), nunca do
  // Product atual. Arredondamento Decimal exato, sem Float.
  const total = order.items.reduce(
    (acc, item) => acc.add(item.subtotal),
    new Prisma.Decimal(0)
  );
  return {
    id: order.id,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    sessionId: order.sessionId,
    tableNumber: order.session.table.number,
    items: order.items.map((item) => ({
      id: item.id,
      productName: item.productName,
      unitPrice: item.unitPrice.toFixed(2),
      quantity: item.quantity,
      subtotal: item.subtotal.toFixed(2),
    })),
    total: total.toFixed(2),
    currency,
  };
}

// Painel operacional: apenas pedidos PENDING / PREPARING / READY do
// restaurante. Tenant scoped pelo where "restaurantId". Todas as relacoes
// (session -> table) e itens vêm na mesma query (sem N+1).
// Ordenacao: fluxo operacional (PENDING, PREPARING, READY) e, dentro de cada
// status, os mais antigos primeiro.
export async function listOperationalOrdersByRestaurantId(
  restaurantId: string
): Promise<OperationalOrderDto[]> {
  const [orders, restaurant] = await Promise.all([
    prisma.order.findMany({
      where: {
        restaurantId,
        status: { in: OPERATIONAL_ORDER_STATUS_LIST },
      },
      select: operationalOrderListSelect,
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    }),
    prisma.restaurant.findFirst({
      where: { id: restaurantId },
      select: { currency: true },
    }),
  ]);
  const currency = restaurant?.currency ?? "BRL";
  return orders.map((order) => toOperationalOrderDto(order, currency));
}

export type UpdateOrderStatusResult =
  | { outcome: "updated"; id: string; status: string; updatedAt: string }
  | { outcome: "order-not-found" }
  | { outcome: "session-closed" }
  | { outcome: "invalid-transition" }
  | { outcome: "status-conflict" };

// Atualizacao condicional/atomica: o WHERE inclui o status esperado.
// Se outra request mudou o estado entre a leitura e o update, a query retorna
// count 0 e a operacao responde 409 ORDER_STATUS_CONFLICT em vez de sobrescrever.
// Nunca expoe pedidos de outro tenant: o where sempre filtra restaurantId, e o
// pedido inexistente/cross-tenant responde "order-not-found" (404).
//
// Etapa 14: toda a maquina de estados operacional (PENDING -> PREPARING ->
// READY) e bloqueada em Orders de Session CLOSED. A protecao e dupla:
//   - validacao de leitura: se a Session da Order ja esta CLOSED, responde
//     "session-closed" (409 SESSION_CLOSED) sem checar a transicao;
//   - condicao atomica no UPDATE: o WHERE exige session.status = OPEN, entao
//     mesmo que um close concorra entre a leitura e o update, o segundo nunca
//     grava numa Session CLOSED (cai em 409 STATUS_CONFLICT). Tenant-scoped.
export async function updateOrderStatus({
  restaurantId,
  orderId,
  status,
}: {
  restaurantId: string;
  orderId: string;
  status: OrderStatus;
}): Promise<UpdateOrderStatusResult> {
  const current = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: {
      status: true,
      session: { select: { status: true } },
    },
  });
  if (!current) {
    return { outcome: "order-not-found" };
  }

  if (current.session.status === SessionStatus.CLOSED) {
    return { outcome: "session-closed" };
  }

  const allowed = ALLOWED_ORDER_TRANSITIONS[current.status];
  if (!allowed.includes(status)) {
    return { outcome: "invalid-transition" };
  }

  const updated = await prisma.order.updateMany({
    where: {
      id: orderId,
      restaurantId,
      status: current.status,
      session: { status: SessionStatus.OPEN },
    },
    data: { status },
  });
  if (updated.count !== 1) {
    return { outcome: "status-conflict" };
  }

  const refreshed = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: { updatedAt: true },
  });
  if (!refreshed) {
    return { outcome: "order-not-found" };
  }

  return {
    outcome: "updated",
    id: orderId,
    status,
    updatedAt: refreshed.updatedAt.toISOString(),
  };
}
import {
  OrderStatus,
  Prisma,
  SessionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getRestaurantById } from "@/services/restaurants";
import { getTableByQrToken } from "@/services/tables";

// ---------- Etapa 12: resumo da mesa e fechamento da Session ----------

// Pedidos que entram no resumo financeiro (CANCELLED fica de fora).
export const FINANCIAL_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PREPARING,
  OrderStatus.READY,
] as const;

export const FINANCIAL_ORDER_STATUS_LIST: OrderStatus[] = [
  ...FINANCIAL_ORDER_STATUSES,
];

// Politica de arredondamento monetario (documentada na Etapa 12):
//   - subtotal : soma exata dos OrderItem.subtotal (decimais de 2 casas).
//   - taxa     : subtotal * serviceFeePercent / 100, arredondada com
//                ROUND_HALF_UP para 2 casas decimais.
//   - total    : subtotal + taxa arredondada (soma exata, sem novo rounding).
// Nunca Float: todo calculo usa Prisma.Decimal.
export const SERVICE_FEE_ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

const summarySessionSelect = {
  id: true,
  status: true,
  openedAt: true,
  closedAt: true,
  table: { select: { id: true, number: true } },
} satisfies Prisma.TableSessionSelect;

const summaryOrderSelect = {
  id: true,
  status: true,
  createdAt: true,
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

export type SessionSummaryDto = {
  session: {
    id: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
  };
  table: { id: string; number: number };
  restaurant: { id: string; name: string; slug: string };
  orders: {
    id: string;
    status: string;
    createdAt: string;
    subtotal: string;
    items: {
      id: string;
      productName: string;
      unitPrice: string;
      quantity: number;
      subtotal: string;
    }[];
  }[];
  subtotal: string;
  serviceFeePercent: string;
  serviceFeeAmount: string;
  total: string;
};

type SummarySessionRow = Prisma.TableSessionGetPayload<{
  select: typeof summarySessionSelect;
}>;

function buildSummaryDto(
  session: SummarySessionRow,
  restaurant: NonNullable<Awaited<ReturnType<typeof getRestaurantById>>>,
  orders: Prisma.OrderGetPayload<{ select: typeof summaryOrderSelect }>[]
): SessionSummaryDto {
  let subtotal = new Prisma.Decimal(0);
  const orderDtos = orders.map((order) => {
    const orderSubtotal = order.items.reduce(
      (acc, item) => acc.add(item.subtotal),
      new Prisma.Decimal(0)
    );
    subtotal = subtotal.add(orderSubtotal);
    return {
      id: order.id,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      subtotal: orderSubtotal.toFixed(2),
      items: order.items.map((item) => ({
        id: item.id,
        productName: item.productName,
        unitPrice: item.unitPrice.toFixed(2),
        quantity: item.quantity,
        subtotal: item.subtotal.toFixed(2),
      })),
    };
  });

  const serviceFeePercent = restaurant.serviceFeePercent;
  const serviceFeeAmount = subtotal
    .mul(serviceFeePercent)
    .div(100)
    .toDecimalPlaces(2, SERVICE_FEE_ROUNDING);
  const total = subtotal.add(serviceFeeAmount);

  return {
    session: {
      id: session.id,
      status: session.status,
      openedAt: session.openedAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
    },
    table: { id: session.table.id, number: session.table.number },
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
    },
    orders: orderDtos,
    subtotal: subtotal.toFixed(2),
    serviceFeePercent: serviceFeePercent.toFixed(2),
    serviceFeeAmount: serviceFeeAmount.toFixed(2),
    total: total.toFixed(2),
  };
}

// Tenant-scoped: a Session so existe para o operador se pertence ao
// restaurantId autorizado. Fora do tenant -> null (404 SESSION_NOT_FOUND),
// sem revelar que a Session existe em outro restaurante.
export async function getSessionSummary({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<SessionSummaryDto | null> {
  const session = await prisma.tableSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: summarySessionSelect,
  });
  if (!session) {
    return null;
  }

  const restaurant = await getRestaurantById(restaurantId);
  if (!restaurant) {
    return null;
  }

  const orders = await prisma.order.findMany({
    where: {
      sessionId,
      restaurantId,
      status: { in: FINANCIAL_ORDER_STATUS_LIST },
    },
    select: summaryOrderSelect,
    orderBy: { createdAt: "asc" },
  });

  return buildSummaryDto(session, restaurant, orders);
}

export type CloseSessionResult =
  | { outcome: "closed" | "already-closed"; summary: SessionSummaryDto }
  | { outcome: "not-found" }
  | { outcome: "has-orders-in-progress" };

// Fechamento idempotente e concorrente-seguro.
//
// Serializacao: em transacao, a linha da Session e travada com SELECT ...
// FOR UPDATE. Dois operadores fechando a mesma mesa no mesmo instante:
//   - o primeiro trava, valida bloqueios, marca CLOSED e faz commit;
//   - o segundo (que estava bloqueado no FOR UPDATE) le a Session ja CLOSED
//     e responde "already-closed" com o MESMO resumo/closedAt.
// Regra de fechamento: so fecha com status OPEN e sem Order PENDING/PREPARING
// (READY/CANCELLED nao bloqueiam). A rejecao e atomica com a mudanca de
// estado (mesma transacao), entao um close bem-sucedido nunca convive com
// pedido em andamento.
export async function closeSession({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<CloseSessionResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`
        SELECT "status" FROM "sessions"
        WHERE "id" = ${sessionId}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
        FOR UPDATE
      `
    );
    if (rows.length === 0) {
      return { outcome: "not-found" } as const;
    }
    if (rows[0].status === SessionStatus.CLOSED) {
      return { outcome: "already-closed" as const };
    }

    const blockers = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT "id" FROM "orders"
        WHERE "sessionId" = ${sessionId}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
          AND CAST("status" AS text)
            IN (${OrderStatus.PENDING}, ${OrderStatus.PREPARING})
        LIMIT 1
      `
    );
    if (blockers.length > 0) {
      return { outcome: "has-orders-in-progress" as const };
    }

    await tx.tableSession.update({
      where: { id: sessionId },
      data: { status: SessionStatus.CLOSED, closedAt: new Date() },
    });
    return { outcome: "closed" as const };
  });

  if (outcome.outcome === "not-found") {
    return outcome;
  }
  if (outcome.outcome === "has-orders-in-progress") {
    return outcome;
  }

  const summary = await getSessionSummary({ restaurantId, sessionId });
  if (!summary) {
    return { outcome: "not-found" };
  }
  return { outcome: outcome.outcome, summary };
}

export const sessionPublicSelect = {
  id: true,
  tableId: true,
  status: true,
  openedAt: true,
  closedAt: true,
} satisfies Prisma.TableSessionSelect;

export type SessionPublic = Prisma.TableSessionGetPayload<{
  select: typeof sessionPublicSelect;
}>;

export async function getOpenSessionByTable({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<SessionPublic | null> {
  return prisma.tableSession.findFirst({
    where: { restaurantId, tableId, status: SessionStatus.OPEN },
    select: sessionPublicSelect,
  });
}

export async function getSessionById({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<SessionPublic | null> {
  return prisma.tableSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: sessionPublicSelect,
  });
}

export type OpenSessionResult =
  | {
      outcome: "created" | "existing";
      session: SessionPublic;
      tableNumber: number;
      restaurant: { slug: string; name: string };
    }
  | { outcome: "table-not-found" }
  | { outcome: "table-inactive" };

export async function getOrCreateOpenSessionForTable({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<{ session: SessionPublic; created: boolean }> {
  const existing = await getOpenSessionByTable({ restaurantId, tableId });
  if (existing) {
    return { session: existing, created: false };
  }

  try {
    const session = await prisma.tableSession.create({
      data: {
        restaurantId,
        tableId,
        status: SessionStatus.OPEN,
      },
      select: sessionPublicSelect,
    });
    return { session, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const conflicting = await getOpenSessionByTable({ restaurantId, tableId });
      if (conflicting) {
        return { session: conflicting, created: false };
      }
    }
    throw error;
  }
}

export async function getOrCreateOpenSessionByQrToken(
  qrToken: string
): Promise<OpenSessionResult> {
  const table = await getTableByQrToken(qrToken);
  if (!table) {
    return { outcome: "table-not-found" };
  }
  if (!table.active) {
    return { outcome: "table-inactive" };
  }

  const { session, created } = await getOrCreateOpenSessionForTable({
    restaurantId: table.restaurant.id,
    tableId: table.id,
  });

  return {
    outcome: created ? "created" : "existing",
    session,
    tableNumber: table.number,
    restaurant: { slug: table.restaurant.slug, name: table.restaurant.name },
  };
}